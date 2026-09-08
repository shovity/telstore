import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_LIST_DOCUMENTS, runList } from '../src/commands/list.js'
import { manifestCaption } from '../src/caption.js'
import { loadConfig, saveConfig } from '../src/config.js'
import { LOGGED_IN, collect, tempDir } from './helpers.js'

async function workspace(config = {}) {
  const configDir = await tempDir('list')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@store', ...config } }, configDir)
  return configDir
}

function manifestMessage({ id, name, size, chunks, createdAt, note = null, msgId = 2000 }) {
  return {
    id: msgId,
    fileName: `${id}.manifest.json`,
    caption: manifestCaption({ id, name, size, chunks, createdAt, note }),
    date: Math.floor(Date.parse(createdAt) / 1000),
  }
}

function deps(configDir, messages, out, extra = {}) {
  return {
    configDir,
    log: out.log,
    connect: async () => ({}),
    disconnect: async () => {},
    readDocuments: async function* () {
      yield* messages
    },
    searchManifests: async function* () {
      yield* messages
    },
    ...extra,
  }
}

const DATA_TAR = manifestMessage({
  id: 'telstore-20260905-7f3a91',
  name: 'data.tar',
  size: 22_998_546_842,
  chunks: 12,
  createdAt: '2026-09-05T16:40:12.000Z',
})

const PHOTOS = manifestMessage({
  id: 'telstore-20260901-9de447',
  name: 'photos.zip',
  size: 985_949_798,
  chunks: 1,
  createdAt: '2026-09-01T08:02:00.000Z',
  msgId: 1900,
})

test('every backup gets a row read from its summary card', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({}, deps(configDir, [DATA_TAR, PHOTOS], out))

  assert.match(out.text(), /BACKUP ID +FILE +SIZE +CHUNKS +CREATED/)
  assert.match(out.text(), /telstore-20260905-7f3a91 +data\.tar +21\.4 GB +12 +2026-09-05/)
  assert.match(out.text(), /telstore-20260901-9de447 +photos\.zip +940\.3 MB +1 +2026-09-01/)
})

test('the footer counts the backups and shows how to restore one', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({}, deps(configDir, [DATA_TAR, PHOTOS], out))

  assert.match(out.text(), /2 backups\./)
  assert.match(out.text(), /npx telstore restore <backup-id>/)
})

// A backup uploaded before the summary card existed still has to be listed. Its id and
// date can be read off the message itself; the rest is unknown and says so.
test('a manifest without a summary card is listed with what the message itself knows', async () => {
  const configDir = await workspace()
  const out = collect()
  const old = {
    id: 1800,
    fileName: 'telstore-20260820-aa11bb.manifest.json',
    caption: '#telstore telstore-20260820-aa11bb manifest',
    date: Math.floor(Date.parse('2026-08-20T09:00:00.000Z') / 1000),
  }

  await runList({}, deps(configDir, [old], out))

  assert.match(out.text(), /telstore-20260820-aa11bb +— +— +— +2026-08-20/)
})

// The search asks Telegram for a tag, and Telegram decides what comes back. A chunk that
// slips into the results must not be counted as a backup of its own.
test('messages that are not manifests are left out', async () => {
  const configDir = await workspace()
  const out = collect()
  const chunk = {
    id: 1500,
    fileName: 'telstore-20260905-7f3a91.part0003',
    caption: '📦 telstore-20260905-7f3a91 · 3/12',
    date: Math.floor(Date.parse('2026-09-05T16:00:00.000Z') / 1000),
  }

  await runList({}, deps(configDir, [chunk, DATA_TAR], out))

  assert.match(out.text(), /1 backup\./)
  assert.doesNotMatch(out.text(), /part0003/)
})

test('an empty chat says so instead of printing an empty table', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({}, deps(configDir, [], out))

  assert.match(out.text(), /No backups found in @store/)
  assert.doesNotMatch(out.text(), /BACKUP ID/)
})

// A flag applies to this run and nothing else: listing another chat must leave the
// configured destination exactly where it was.
test('--chat looks somewhere else without changing the configured destination', async () => {
  const configDir = await workspace()
  const out = collect()
  let asked = null

  await runList({ chat: '@other' }, deps(configDir, [], out, {
    readDocuments: async function* (client, chat) {
      asked = chat
    },
  }))

  assert.equal(asked, '@other')
  assert.equal((await loadConfig(configDir)).settings.chat, '@store')
})

// --limit is a number of backups, and the walk stops the moment it has that many: a chat of
// ten thousand chunk messages must cost one request to list the backups at the top of it,
// not ten.
test('--limit caps the backups listed, and the walk stops there', async () => {
  const configDir = await workspace()
  const out = collect()
  let read = 0

  const many = Array.from({ length: 6 }, (_, i) =>
    manifestMessage({
      id: `telstore-2026090${i + 1}-00000${i + 1}`,
      name: `f${i}.tar`,
      size: 1024,
      chunks: 1,
      createdAt: '2026-09-01T10:00:00.000Z',
      msgId: 3000 + i,
    }),
  )

  await runList({ limit: '5' }, deps(configDir, [], out, {
    readDocuments: async function* () {
      for (const message of many) {
        read += 1
        yield message
      }
    },
  }))

  assert.match(out.text(), /5 backups\./)
  assert.equal(read, 5)
})

// The walk is the whole of what list knows, so it has to be told where to stop.
test('list walks with a ceiling rather than to the end of the chat', async () => {
  const configDir = await workspace()
  const out = collect()
  let asked = null

  await runList({}, deps(configDir, [], out, {
    readDocuments: async function* (client, chat, options) {
      asked = options
    },
  }))

  assert.equal(asked.max, MAX_LIST_DOCUMENTS)
})

// "No backups found" is a claim about a whole chat, and the walk only ever saw the newest
// part of it. Saying it after stopping at the ceiling would be the silence this project
// does not do — the backups may be one message further back.
test('a chat too long to walk to the end says what it actually looked at', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({}, deps(configDir, [], out, {
    readDocuments: async function* () {
      for (let i = 0; i < MAX_LIST_DOCUMENTS; i += 1) {
        yield { id: 9000 - i, fileName: `telstore-20260905-7f3a91.part${i}`, caption: '', date: 0 }
      }
    },
  }))

  assert.match(out.text(), new RegExp(`newest ${MAX_LIST_DOCUMENTS} documents`))
  assert.doesNotMatch(out.text(), /No backups found in @store\./)
})

test('a backup found before the ceiling still warns that older ones may be further back', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({}, deps(configDir, [], out, {
    readDocuments: async function* () {
      yield DATA_TAR
      for (let i = 1; i < MAX_LIST_DOCUMENTS; i += 1) {
        yield { id: 9000 - i, fileName: `telstore-20260905-7f3a91.part${i}`, caption: '', date: 0 }
      }
    },
  }))

  assert.match(out.text(), /1 backup\./)
  assert.match(out.text(), new RegExp(`newest ${MAX_LIST_DOCUMENTS} documents`))
})

test('a --limit that is not a positive whole number is refused', async () => {
  const configDir = await workspace()
  const out = collect()

  await assert.rejects(() => runList({ limit: '0' }, deps(configDir, [], out)), /--limit/)
})

// Nothing about a destination helps someone who has not logged in yet, and list reaches
// requireChat before it ever opens a connection.
test('list before a login asks for the login, not for a destination', async () => {
  const configDir = await tempDir('list')
  const out = collect()

  await assert.rejects(
    () => runList({}, { ...deps(configDir, [], out), configDir }),
    /log in|login/i,
  )
})

test('an empty Saved Messages is named, not called "me"', async () => {
  const configDir = await workspace({ chat: 'me' })
  const out = collect()

  await runList({}, deps(configDir, [], out))

  assert.match(out.text(), /No backups found in Saved Messages/)
})

// The id is the one field that has to be right: restore looks the manifest up by it.
// The file name is telstore's own, the caption is text anyone in the chat can edit.
test('the backup id comes from the file name, not from the caption', async () => {
  const configDir = await workspace()
  const out = collect()
  const edited = {
    ...DATA_TAR,
    caption: DATA_TAR.caption.replace('telstore-20260905-7f3a91', 'telstore-tampered-000000'),
  }

  await runList({}, deps(configDir, [edited], out))

  assert.match(out.text(), /telstore-20260905-7f3a91/)
  assert.doesNotMatch(out.text(), /telstore-tampered-000000/)
})

const NOTED = manifestMessage({
  id: 'telstore-20260903-c41d02',
  name: 'accounts.tar',
  size: 1024,
  chunks: 1,
  createdAt: '2026-09-03T10:00:00.000Z',
  note: 'quarterly accounts',
  msgId: 1950,
})

test('a backup with a note gets a column for it', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({}, deps(configDir, [NOTED], out))

  assert.match(out.text(), /BACKUP ID +FILE +SIZE +CHUNKS +CREATED +NOTE/)
  assert.match(out.text(), /2026-09-03 +quarterly accounts/)
})

// Nobody has to look at a column of dashes to learn that they have never written a note.
test('no notes anywhere means no column for them', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({}, deps(configDir, [DATA_TAR, PHOTOS], out))

  assert.equal(out.text().includes('NOTE'), false)
})

test('a backup without a note beside one that has a note shows a dash', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({}, deps(configDir, [NOTED, PHOTOS], out))

  assert.match(out.text(), /photos\.zip .* 2026-09-01 +—/)
})

// The table is for reading at a glance, and a 500-character note would push every column
// off the side of it. The whole note is still in the manifest and on the card in the chat.
test('a note too long for the table is cut short with an ellipsis', async () => {
  const configDir = await workspace()
  const out = collect()
  const long = manifestMessage({
    id: 'telstore-20260902-aabbcc',
    name: 'long.tar',
    size: 1024,
    chunks: 1,
    createdAt: '2026-09-02T10:00:00.000Z',
    note: 'x'.repeat(60),
    msgId: 1940,
  })

  await runList({}, deps(configDir, [long], out))

  assert.match(out.text(), new RegExp(`${'x'.repeat(39)}…(\\s|$)`))
  assert.equal(out.text().includes('x'.repeat(40)), false)
})

// --search asks Telegram's index for manifests carrying the term, then keeps only the ones
// the term really appears in. The second half is not belt-and-braces: measured 2026-09-08,
// a search for "2026-09" came back with every document in the chat, so trusting the server's
// answer would list backups from months the user did not ask about.
const REPORTS = manifestMessage({
  id: 'telstore-20260903-11aa22',
  name: 'reports.zip',
  size: 4096,
  chunks: 1,
  createdAt: '2026-09-03T09:15:00.000Z',
  msgId: 2500,
})

function searchDeps(configDir, hits, out, extra = {}) {
  return deps(configDir, [], out, {
    readDocuments: async function* () {
      throw new Error('--search must not walk the chat')
    },
    searchManifests: async function* () {
      yield* hits
    },
    ...extra,
  })
}

test('--search lists only the backups the term appears in', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({ search: 'reports' }, searchDeps(configDir, [REPORTS, DATA_TAR], out))

  assert.match(out.text(), /reports\.zip/)
  assert.doesNotMatch(out.text(), /data\.tar/)
  assert.match(out.text(), /1 backup matching "reports"\./)
})

test('--search names what was searched for above the table', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({ search: 'reports' }, searchDeps(configDir, [REPORTS], out))

  assert.match(out.text(), /Search +"reports"/)
})

test('--search ignores case', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({ search: 'REPORTS.ZIP' }, searchDeps(configDir, [REPORTS, DATA_TAR], out))

  assert.match(out.text(), /1 backup matching/)
})

// The table cuts a note at 40 characters because a long one would push every other column
// off the side. Matching the cut version would lose the word the person actually typed, so
// the whole note out of the manifest card is what --search compares against.
test('--search matches a note past the 40 characters the table shows', async () => {
  const configDir = await workspace()
  const out = collect()
  const long = manifestMessage({
    id: 'telstore-20260902-33cc44',
    name: 'ledger.tar',
    size: 4096,
    chunks: 1,
    createdAt: '2026-09-02T09:00:00.000Z',
    note: `${'padding '.repeat(6)}quarterly`,
    msgId: 2600,
  })

  await runList({ search: 'quarterly' }, searchDeps(configDir, [long, DATA_TAR], out))

  assert.match(out.text(), /ledger\.tar/)
  assert.match(out.text(), /1 backup matching/)
})

test('--search matches a backup id', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({ search: 'telstore-20260903-11aa22' }, searchDeps(configDir, [REPORTS, DATA_TAR], out))

  assert.match(out.text(), /reports\.zip/)
  assert.match(out.text(), /1 backup matching/)
})

test('--search matches the day a backup was created', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({ search: '2026-09-03' }, searchDeps(configDir, [REPORTS, DATA_TAR], out))

  assert.match(out.text(), /reports\.zip/)
  assert.doesNotMatch(out.text(), /data\.tar/)
})

// The measurement that made the client-side pass non-negotiable: "2026-09" returned all 23
// documents of the real chat, chunks included. A month is a thing people search for, and it
// must not answer with backups from another one.
test('a hit the term does not actually appear in is left out', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({ search: '2026-09-03' }, searchDeps(configDir, [REPORTS, PHOTOS], out))

  assert.match(out.text(), /1 backup matching/)
  assert.doesNotMatch(out.text(), /photos\.zip/)
})

test('--search hands the term to the index rather than walking the chat', async () => {
  const configDir = await workspace()
  const out = collect()
  let asked = null

  await runList({ search: 'reports' }, searchDeps(configDir, [], out, {
    searchManifests: async function* (client, chat, term, options) {
      asked = { chat, term, options }
    },
  }))

  assert.equal(asked.chat, '@store')
  assert.equal(asked.term, 'reports')
  assert.equal(asked.options.max, MAX_LIST_DOCUMENTS)
})

test('--limit counts the backups that matched, not the hits read', async () => {
  const configDir = await workspace()
  const out = collect()
  const many = Array.from({ length: 6 }, (_, i) =>
    manifestMessage({
      id: `telstore-2026090${i + 1}-0000a${i}`,
      name: `report${i}.tar`,
      size: 1024,
      chunks: 1,
      createdAt: '2026-09-01T10:00:00.000Z',
      msgId: 3100 + i,
    }),
  )

  await runList({ search: 'report', limit: '4' }, searchDeps(configDir, many, out))

  assert.match(out.text(), /4 backups matching "report"\./)
})

// A search that finds nothing has two causes that look identical from here: the word is not
// in any backup, or it is there but not as a whole word. Telegram matches whole words only —
// "projex" finds projex.zip and "proj" does not — so the answer says both, and points at the
// listing that does not go through the index at all.
test('nothing matching says so, and says how the matching works', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({ search: 'proj' }, searchDeps(configDir, [], out))

  assert.match(out.text(), /No backups matching "proj" in @store/)
  assert.match(out.text(), /whole words/)
  assert.match(out.text(), /without --search/)
  assert.doesNotMatch(out.text(), /BACKUP ID/)
})

test('an empty --search is refused rather than listing everything', async () => {
  const configDir = await workspace()
  const out = collect()

  await assert.rejects(() => runList({ search: '   ' }, searchDeps(configDir, [], out)), /--search/)
})
