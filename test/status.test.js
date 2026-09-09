import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { runStatus } from '../src/commands/status.js'
import { loadConfig, saveConfig } from '../src/config.js'
import {
  restoreFile,
  restoreKey,
  saveRestore,
  saveState,
  stateFile,
  stateKey,
  streamKey,
} from '../src/state.js'

import { LOGGED_IN, collect, tempDir } from './helpers.js'

function fakeClient(me = { firstName: 'Sho', username: 'shovity' }) {
  return { async getMe() { return me } }
}

test('status without a login says so and never opens a connection', async () => {
  const configDir = await tempDir('status')
  const out = collect()
  let connected = false

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => { connected = true; return fakeClient() },
    disconnect: async () => {},
  })

  assert.equal(connected, false)
  assert.match(out.text(), /Not logged in/)
})

test('status reports the account, the destination and nothing unfinished', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  const out = collect()

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  const text = out.text()
  assert.match(text, /Sho \(@shovity\)/)
  assert.match(text, /@my_backups/)
  assert.match(text, /none/i)
})

test('an expired session is reported, not thrown', async () => {
  const configDir = await tempDir('status')
  await saveConfig(LOGGED_IN, configDir)
  const out = collect()

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => { throw new Error('Session expired — run "npx telstore login".') },
    disconnect: async () => {},
  })

  assert.match(out.text(), /Session expired/)
})

test('status lists each unfinished backup with how far it got', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  await saveState('aaa', {
    id: 'telstore-20260905-02e053',
    chat: '@my_backups',
    path: '/home/ai/data.tar',
    size: 100,
    mtimeMs: 1,
    chunkSize: 40,
    done: { 0: {}, 1: {} },
  }, configDir)
  const out = collect()

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  const text = out.text()
  assert.match(text, /telstore-20260905-02e053/)
  assert.match(text, /data\.tar/)
  // 100 bytes in 40-byte chunks is three chunks, two of them already sent.
  assert.match(text, /Chunks\s+2 of 3 uploaded/)
})

test('the connection is closed even when getMe fails', async () => {
  const configDir = await tempDir('status')
  await saveConfig(LOGGED_IN, configDir)
  const out = collect()
  let closed = false

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => ({ async getMe() { throw new Error('AUTH_KEY_UNREGISTERED') } }),
    disconnect: async () => { closed = true },
  })

  assert.equal(closed, true)
  assert.match(out.text(), /AUTH_KEY_UNREGISTERED/)
})

test('status --chat reports that destination without saving it', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@old' } }, configDir)
  const out = collect()

  await runStatus({ chat: '@new' }, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  assert.match(out.text(), /Destination\s+https:\/\/web\.telegram\.org\/k\/#@new/)
  assert.doesNotMatch(out.text(), /@old/)
  assert.equal((await loadConfig(configDir)).settings.chat, '@old', 'a flag must never write')
})

test('status --chat with an unusable destination is refused, not shown', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@old' } }, configDir)
  const out = collect()

  await runStatus({ chat: '  ' }, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  assert.match(out.text(), /Destination\s+.*must not be empty/)
  assert.equal((await loadConfig(configDir)).settings.chat, '@old')
})

// status is the one command someone runs because something is already wrong, so a setting
// it cannot parse belongs in its own row — not in an exception that hides the account line
// and the unfinished backups underneath it.
test('a stored setting that cannot be parsed is reported in its row, not thrown', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: 42.5 } }, configDir)
  const out = collect()

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  assert.match(out.text(), /Account/)
  assert.match(out.text(), /Unfinished/)
  assert.match(out.text(), /chat in .*config\.json/)
})

test('the destination is shown as a link that can be clicked', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '-5107543795' } }, configDir)
  await saveState('aaa', {
    id: 'telstore-1',
    chat: '@my_backups',
    path: '/home/ai/data.tar',
    size: 100,
    mtimeMs: 1,
    chunkSize: 40,
    done: {},
  }, configDir)
  const out = collect()

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  const text = out.text()
  assert.match(text, /Destination\s+https:\/\/web\.telegram\.org\/k\/#-5107543795/)
  // The unfinished backup goes to a different chat, and follows the same form.
  assert.match(text, /https:\/\/web\.telegram\.org\/k\/#@my_backups/)
})

test('Saved Messages is named rather than linked', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: 'me' } }, configDir)
  const out = collect()

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  assert.match(out.text(), /Destination\s+me \(Saved Messages\)/)
})

// An unfinished backup is resumed by running the same upload command again, and the record
// is found by hashing the file's path, size and mtime — so these tests file each record
// under the key a real file on disk actually produces, the way runUpload would.
async function saveResumable(configDir, { name = 'data.tar', body = 'hello', ...rest } = {}) {
  const dir = await tempDir('source')
  const file = path.join(dir, name)
  await fs.writeFile(file, body)
  const stat = await fs.stat(file)

  const state = {
    id: 'telstore-20260905-02e053',
    chat: '@my_backups',
    path: file,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    chunkSize: 40,
    done: {},
    ...rest,
  }

  await saveState(stateKey(file, stat.size, stat.mtimeMs), state, configDir)

  return file
}

async function report(configDir, options = {}) {
  const out = collect()

  await runStatus(options, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  return out.text()
}

// The old report printed only the basename, which is the one thing that cannot be pasted
// back: the record is keyed on the absolute path, so a resume typed from `data.tar` alone
// starts a second backup and abandons the chunks the first one already sent.
test('a resumable backup is shown with the command that resumes it', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  const file = await saveResumable(configDir)

  const text = await report(configDir)

  assert.match(text, new RegExp(`File\\s+${file}`))
  assert.match(text, new RegExp(`Resume\\s+npx telstore ${file}$`, 'm'))
})

// Sending the rest of a backup somewhere else is what runUpload refuses outright, so the
// command status prints has to name the chat the chunks are already in.
test('the resume command carries --chat when the backup goes somewhere else', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@elsewhere' } }, configDir)
  const file = await saveResumable(configDir, { chat: '@my_backups' })

  const text = await report(configDir)

  assert.match(text, new RegExp(`Resume\\s+npx telstore ${file} --chat @my_backups$`, 'm'))
})

test('the resume command leaves out --chat when the destination already matches', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  await saveResumable(configDir, { chat: '@my_backups' })

  assert.doesNotMatch(await report(configDir), /--chat/)
})

// With no destination to compare against there is no way to know the chat still matches,
// and a command that leaves --chat out would be a guess about where the chunks went.
test('the resume command carries --chat when the destination cannot be read', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: 42.5 } }, configDir)
  await saveResumable(configDir, { chat: '@my_backups' })

  assert.match(await report(configDir), /Resume\s+npx telstore .* --chat @my_backups$/m)
})

test('a path with a space in it is quoted so the command can be pasted', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  const file = await saveResumable(configDir, { name: 'my data.tar' })

  assert.match(await report(configDir), new RegExp(`Resume\\s+npx telstore '${file}'$`, 'm'))
})

// Printing the command anyway would be telling the user to run something that quietly
// starts a second backup: the key hashes the mtime, so upload would never find this record.
test('a backup whose file has changed says so instead of offering a command', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  const file = await saveResumable(configDir, { done: { 0: {}, 1: {} } })
  await fs.writeFile(file, 'rewritten, and longer than before')

  const text = await report(configDir)

  assert.doesNotMatch(text, /npx telstore/)
  assert.match(text, /Resume\s+not possible: the file has changed/)
  // Two chunks are sitting in the chat with nothing left to point at them.
  assert.match(text, /2 chunks are already in the chat/)
})

test('a backup whose file is gone says that, not that it changed', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  const file = await saveResumable(configDir)
  await fs.unlink(file)

  assert.match(await report(configDir), /Resume\s+not possible: the file is no longer there/)
})

// Nothing was stranded, so there is nothing to go looking for in the chat.
test('an unresumable backup that never sent a chunk mentions no stranded chunks', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  const file = await saveResumable(configDir)
  await fs.unlink(file)

  assert.doesNotMatch(await report(configDir), /already in the chat/)
})

// --- a record nothing can resume ----------------------------------------------------

async function saveStream(configDir, { id = 'telstore-1', ...rest } = {}) {
  const state = {
    v: 1,
    kind: 'stream',
    id,
    chat: '@my_backups',
    name: 'a.tar',
    chunkSize: 40,
    done: { 0: { msgId: 5, size: 10, sha256: 'x' } },
    ...rest,
  }

  await saveState(streamKey(id), state, configDir)

  return state
}

// A stream record is not an unfinished transfer waiting to be picked up: the bytes came from
// a command's stdout, they have gone past, and the next run cuts them differently. What it
// names is chunks sitting in a chat with no manifest pointing at them, which is a different
// sentence and a different command.
test('a stream record is leftover chunks, not an unfinished upload to resume', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  await saveStream(configDir)

  const text = await report(configDir)

  assert.match(text, /a\.tar/)
  assert.match(text, /npx telstore delete telstore-1 --chat @my_backups$/m)
  assert.doesNotMatch(text, /npx telstore a\.tar/)
  assert.doesNotMatch(text, /Resume/)
})

// The report used to build every row out of a path, a size and a chunk count a stream record
// does not have: "File undefined (NaN B)", and "not possible: undefined" underneath it.
test('a stream record is printed without an undefined path or a NaN chunk count', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  await saveStream(configDir)

  assert.doesNotMatch(await report(configDir), /undefined|NaN/)
})

// The one place status departs from its own --chat rule, and on purpose. A resume command is
// the same upload again, which refuses to send the rest of a backup anywhere else. A delete
// command is message ids, and runDelete resolves the chat from config: printed without
// --chat it would fire these ids at whatever destination is configured when it is pasted,
// destroying whatever carries them there. The chat costs a few characters; leaving it out
// costs somebody else's messages, and nothing undoes that.
test('the delete command names the chat even when the destination already matches', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  await saveStream(configDir, { chat: '@my_backups' })

  assert.match(await report(configDir), /--chat @my_backups/)
})

test('a chat that needs quoting is quoted so the delete command can be pasted', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  await saveStream(configDir, { chat: 'my chat' })

  assert.match(await report(configDir), /--chat 'my chat'$/m)
})

// The record delete reads a manifest id out of is exactly the record a failed rollback leaves
// behind, so "with no manifest naming them" is a claim its own record can contradict — the
// same claim delete guards where it says a search returned nothing rather than that nothing
// was sent. status asks Telegram nothing here, so it reports what the record says and says
// that is what it is.
test('a stream record whose manifest went out is not said to have none', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  await saveStream(configDir, { manifestMsgId: 900 })

  const text = await report(configDir)

  assert.doesNotMatch(text, /no manifest/)
  assert.match(text, /the manifest its record names/)
})

// delete's stateManifestId reads the same field and treats null exactly as absent, so a
// record carrying an explicit null must not have status promising a manifest that delete
// then reports finding no record of. One record, one answer, whichever command is asked.
test('a stream record whose manifest id is null is described as having none', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  await saveStream(configDir, { manifestMsgId: null })

  const text = await report(configDir)

  assert.match(text, /with no manifest naming them/)
  assert.doesNotMatch(text, /the manifest its record names/)
})

// status is the command someone runs *because* something is wrong, so a record a truncated
// write or a hand edit mangled is nearer its normal case than its edge case.
test('a stream record that does not name what produced it prints no undefined', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  await saveStream(configDir, { name: undefined })

  const text = await report(configDir)

  assert.doesNotMatch(text, /undefined/)
  assert.match(text, /Remove\s+npx telstore delete/)
})

// A delete command built without a chat is the hazard --chat exists to prevent, arrived at by
// another road: runDelete would resolve a destination from config and fire these ids at
// whatever that turns out to be. A record that cannot say where the chunks went gets no
// command at all.
test('a stream record with no chat is not given a command that would guess one', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  await saveStream(configDir, { chat: undefined })

  const text = await report(configDir)

  assert.doesNotMatch(text, /undefined/)
  assert.doesNotMatch(text, /npx telstore delete/)
  assert.match(text, /does not say which chat/)
})

// The same reason accountLine catches its own failures: one bad record must not swallow
// the report that someone ran status to read.
test('a record with a damaged path does not hide the backup after it', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  await saveState('aaa', {
    id: 'telstore-damaged',
    chat: '@my_backups',
    path: null,
    size: 100,
    mtimeMs: 1,
    chunkSize: 40,
    done: {},
  }, configDir)
  await saveResumable(configDir, { id: 'telstore-fine' })

  const text = await report(configDir)

  assert.match(text, /telstore-damaged/)
  assert.match(text, /telstore-fine/)
  assert.match(text, /Resume\s+npx telstore /)
})

// status never said which config it read. That is worth knowing at any time, and it is the
// only place someone can see that this machine's session is a sealed one — so the row is
// printed always, because a row that appears only sometimes reads as a warning.
test('status names the config file the session came from', async () => {
  const configDir = await tempDir('status')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  assert.match(out.text(), new RegExp(`Session\\s+${configDir}/config.json`))
})

test('status says when the session on this machine is sealed', async () => {
  const configDir = await tempDir('status')
  const out = collect()
  await saveConfig({ sealed: 'tls1.abc' }, configDir)

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  assert.match(out.text(), /Session\s+.*config\.json \(sealed/)
})

async function savedRestore(configDir, overrides = {}) {
  const record = {
    v: 1,
    id: 'telstore-20260901-7c1b40',
    target: '/home/ai/out.tar',
    chat: '@my_backups',
    size: 1000,
    chunks: 7,
    done: 4,
    ...overrides,
  }

  await saveRestore(restoreKey(record.id, record.target), record, configDir)

  return record
}

test('status names an unfinished restore and how to carry it on', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)

  const dir = await tempDir('status-target')
  const target = path.join(dir, 'out.tar')
  await fs.writeFile(`${target}.partial`, 'x')
  await savedRestore(configDir, { target })

  const out = collect()
  await runStatus({}, {
    configDir, log: out.log,
    connect: async () => fakeClient(), disconnect: async () => {},
  })

  const text = out.text()
  assert.match(text, /1 restore/)
  assert.match(text, /4 of 7 restored/)
  assert.match(text, new RegExp(`npx telstore restore telstore-20260901-7c1b40 --out ${target}`))
  assert.doesNotMatch(text, /--chat/)
})

test('a restore whose chunks are in another chat is resumed with --chat', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@somewhere_else' } }, configDir)

  const dir = await tempDir('status-target')
  const target = path.join(dir, 'out.tar')
  await fs.writeFile(`${target}.partial`, 'x')
  await savedRestore(configDir, { target })

  const out = collect()
  await runStatus({}, {
    configDir, log: out.log,
    connect: async () => fakeClient(), disconnect: async () => {},
  })

  assert.match(out.text(), /--chat @my_backups/)
})

test('a restore whose .partial is gone says so instead of offering a command', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)

  const dir = await tempDir('status-target')
  await savedRestore(configDir, { target: path.join(dir, 'out.tar') })

  const out = collect()
  await runStatus({}, {
    configDir, log: out.log,
    connect: async () => fakeClient(), disconnect: async () => {},
  })

  const text = out.text()
  assert.match(text, /not possible: the partial download is no longer there/)
  assert.doesNotMatch(text, /npx telstore restore/)
})

test('unfinished uploads and restores are listed newest first, mixed together', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)

  const oldKey = stateKey('/home/ai/old.tar', 100, 1)
  await saveState(oldKey, {
    id: 'telstore-old', chat: '@my_backups', path: '/home/ai/old.tar',
    size: 100, mtimeMs: 1, chunkSize: 40, done: {},
  }, configDir)

  const midKey = restoreKey('telstore-mid', '/home/ai/mid.tar')
  await saveRestore(midKey, {
    v: 1, id: 'telstore-mid', target: '/home/ai/mid.tar', chat: '@my_backups',
    size: 100, chunks: 3, done: 1,
  }, configDir)

  const newKey = stateKey('/home/ai/new.tar', 100, 1)
  await saveState(newKey, {
    id: 'telstore-new', chat: '@my_backups', path: '/home/ai/new.tar',
    size: 100, mtimeMs: 1, chunkSize: 40, done: {},
  }, configDir)

  // Set deliberately, minutes apart, rather than hoping a tight write loop produces
  // genuinely different mtimes on whatever filesystem the tests happen to run on.
  const now = Date.now() / 1000
  await fs.utimes(stateFile(oldKey, configDir), now, now - 3000)
  await fs.utimes(restoreFile(midKey, configDir), now, now - 2000)
  await fs.utimes(stateFile(newKey, configDir), now, now - 1000)

  const out = collect()
  await runStatus({}, {
    configDir, log: out.log,
    connect: async () => fakeClient(), disconnect: async () => {},
  })

  const text = out.text()
  const posNew = text.indexOf('telstore-new')
  const posMid = text.indexOf('telstore-mid')
  const posOld = text.indexOf('telstore-old')

  assert.ok(posNew >= 0 && posMid >= 0 && posOld >= 0, `expected all three ids in:\n${text}`)
  assert.ok(posNew < posMid && posMid < posOld, `expected newest-first order, got:\n${text}`)
})

test('a restore whose .partial cannot be read says so, not that it is gone', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)

  const dir = await tempDir('status-target')
  const target = path.join(dir, 'out.tar')
  await fs.writeFile(`${target}.partial`, 'x')
  await savedRestore(configDir, { target })

  // No execute permission on the parent directory turns fs.stat into EACCES — the file is
  // still there, unlike the ENOENT case the existing wording is written for.
  await fs.chmod(dir, 0o000)

  const out = collect()
  try {
    await runStatus({}, {
      configDir, log: out.log,
      connect: async () => fakeClient(), disconnect: async () => {},
    })
  } finally {
    await fs.chmod(dir, 0o755)
  }

  const text = out.text()
  assert.match(text, /not possible: the partial download cannot be read\./)
  assert.doesNotMatch(text, /no longer there/)
})

test('uploads and restores are counted separately in one line', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)

  await saveState(stateKey('/home/ai/data.tar', 100, 1757000000000), {
    id: 'telstore-20260905-7f3a91', chat: '@my_backups', path: '/home/ai/data.tar',
    size: 100, mtimeMs: 1757000000000, chunkSize: 40, done: {},
  }, configDir)

  const dir = await tempDir('status-target')
  const target = path.join(dir, 'out.tar')
  await fs.writeFile(`${target}.partial`, 'x')
  await savedRestore(configDir, { target })

  const out = collect()
  await runStatus({}, {
    configDir, log: out.log,
    connect: async () => fakeClient(), disconnect: async () => {},
  })

  assert.match(out.text(), /Unfinished\s+1 upload, 1 restore/)
})

test('the plural forms show up once there is more than one of a kind', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)

  await saveState(stateKey('/home/ai/a.tar', 100, 1757000000000), {
    id: 'telstore-20260905-000001', chat: '@my_backups', path: '/home/ai/a.tar',
    size: 100, mtimeMs: 1757000000000, chunkSize: 40, done: {},
  }, configDir)
  await saveState(stateKey('/home/ai/b.tar', 100, 1757000000000), {
    id: 'telstore-20260905-000002', chat: '@my_backups', path: '/home/ai/b.tar',
    size: 100, mtimeMs: 1757000000000, chunkSize: 40, done: {},
  }, configDir)

  const dir = await tempDir('status-target')
  const target = path.join(dir, 'out.tar')
  await fs.writeFile(`${target}.partial`, 'x')
  await savedRestore(configDir, { target })

  const out = collect()
  await runStatus({}, {
    configDir, log: out.log,
    connect: async () => fakeClient(), disconnect: async () => {},
  })

  assert.match(out.text(), /Unfinished\s+2 uploads, 1 restore/)
})

test('a restore record that will not parse does not take the report down', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)

  await savedRestore(configDir)
  await fs.writeFile(
    path.join(configDir, 'state', 'restore-deadbeef.json'),
    '{ not json',
  )

  const out = collect()
  await runStatus({}, {
    configDir, log: out.log,
    connect: async () => fakeClient(), disconnect: async () => {},
  })

  assert.match(out.text(), /Sho \(@shovity\)/)
  assert.match(out.text(), /1 restore/)
})

test('an upload record with a damaged size does not take the report down', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)

  // Parses, reaches the renderer, and carries a field the renderer does arithmetic on —
  // formatBytes used to throw on this, taking every entry sorted after it down too.
  await saveState('aaa', {
    id: 'telstore-20260905-02e053',
    chat: '@my_backups',
    path: '/home/ai/data.tar',
    size: 'not-a-number',
    mtimeMs: 1,
    chunkSize: 40,
    done: {},
  }, configDir)

  const out = collect()
  await runStatus({}, {
    configDir, log: out.log,
    connect: async () => fakeClient(), disconnect: async () => {},
  })

  assert.match(out.text(), /Sho \(@shovity\)/)
  assert.match(out.text(), /1 upload/)
})

test('a restore record with a damaged size does not take the report down', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)

  const dir = await tempDir('status-target')
  const target = path.join(dir, 'out.tar')
  await fs.writeFile(`${target}.partial`, 'x')

  // Parses, reaches the renderer, and carries a field the renderer does arithmetic on.
  // The unparseable-JSON test above never gets this far: readRecord drops it first.
  await savedRestore(configDir, { target, size: 'not-a-number' })

  const out = collect()
  await runStatus({}, {
    configDir, log: out.log,
    connect: async () => fakeClient(), disconnect: async () => {},
  })

  assert.match(out.text(), /Sho \(@shovity\)/)
  assert.match(out.text(), /1 restore/)
})
