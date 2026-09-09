import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

import { runDelete } from '../src/commands/delete.js'
import { saveConfig } from '../src/config.js'
import {
  buildManifest,
  chunkFileName,
  manifestFileName,
  serializeManifest,
} from '../src/manifest.js'
import { findRestores, restoreKey, saveRestore, saveState, stateDir } from '../src/state.js'
import { LOGGED_IN, collect, tempDir } from './helpers.js'

const ID = 'telstore-20260905-7f3a91'

async function workspace(settings = {}) {
  const configDir = await tempDir('delete')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@store', ...settings } }, configDir)
  return configDir
}

function manifestBody({ id = ID, total = 3, first = 1000 } = {}) {
  const chunks = Array.from({ length: total }, (_, i) => ({
    i,
    msgId: first + i,
    size: 400,
    sha256: 'a'.repeat(64),
  }))

  return buildManifest({ id, name: 'data.tar', size: 400 * total, chunkSize: 400, chunks })
}

// Records what delete asks Telegram to remove, in the order it asks. The order is the whole
// point of several tests below, so it is kept rather than flattened into a set.
function recorder({ failAfter = null, failOnManifest = false, manifestId = null } = {}) {
  const calls = []

  return {
    calls,
    ids: () => calls.flatMap((call) => call),
    deleteMessages: async (client, peer, ids, options = {}) => {
      if (failOnManifest && manifestId !== null && ids.includes(manifestId)) {
        throw new Error('server said no')
      }

      let done = 0
      for (const id of ids) {
        if (failAfter !== null && done === failAfter) throw new Error('server said no')
        done += 1
        options.onBatch?.(done, ids.length)
      }

      calls.push([...ids])
      return ids.length
    },
  }
}

function deps(configDir, { manifest = null, manifestMsgId = 2000, out, rec, ...extra } = {}) {
  const bytes = manifest === null ? null : Buffer.from(JSON.stringify(manifest))

  return {
    configDir,
    log: out?.log ?? (() => {}),
    writeErr: () => {},
    connect: async () => ({}),
    disconnect: async () => {},
    confirm: async () => true,
    retryOptions: { attempts: 1 },
    searchManifest: async () =>
      bytes === null ? null : { id: manifestMsgId, fileName: manifestFileName(ID) },
    // An empty chat unless a test says otherwise. Every assertion below about what delete
    // removes is about what the manifest and the record name, and a walk that finds nothing
    // is what leaves those alone.
    readDocuments: async function* () {},
    writeProgress: null,
    readMessageBytes: async () => bytes,
    deleteMessages: rec?.deleteMessages ?? (async () => 0),
    ...extra,
  }
}

async function unfinished(configDir, { id = ID, done = { 0: { msgId: 500, size: 4, sha256: 'x' } } } = {}) {
  await saveState(
    'statekey',
    { id, chat: '@store', path: '/home/me/data.tar', size: 1200, mtimeMs: 1, chunkSize: 400, done },
    configDir,
  )
}

// The record a stream upload leaves behind when its rollback could not finish. No path — the
// bytes came from a command's stdout — and, once the manifest has gone out, the id of the
// card as well as the ids of the chunks.
async function unfinishedStream(
  configDir,
  { id = ID, done = { 0: { msgId: 500, size: 4, sha256: 'x' } }, ...rest } = {},
) {
  await saveState(
    'streamkey',
    { v: 1, kind: 'stream', id, chat: '@store', name: 'a.tar', chunkSize: 400, done, ...rest },
    configDir,
  )
}

const stateFiles = async (configDir) => await fs.readdir(stateDir(configDir)).catch(() => [])

// --- the order that makes an interrupted delete recoverable -------------------------

test('the chunks go first and the manifest goes last', async () => {
  const configDir = await workspace()
  const rec = recorder()

  await runDelete(ID, {}, deps(configDir, { manifest: manifestBody(), rec }))

  assert.deepEqual(rec.calls, [[1000, 1001, 1002], [2000]])
})

test('a chunk that Telegram refuses leaves the manifest in place', async () => {
  const configDir = await workspace()
  const rec = recorder({ failAfter: 2 })

  await assert.rejects(
    () => runDelete(ID, {}, deps(configDir, { manifest: manifestBody(), rec })),
    /Removed 2 of 3 chunk messages/,
  )

  assert.deepEqual(rec.ids(), [])
})

test('a chunk that Telegram refuses names the way to finish the job', async () => {
  const configDir = await workspace()

  await assert.rejects(
    () => runDelete(ID, {}, deps(configDir, { manifest: manifestBody(), rec: recorder({ failAfter: 0 }) })),
    /run the same command again/i,
  )
})

test('a chunk that Telegram refuses leaves the local record alone', async () => {
  const configDir = await workspace()
  await unfinished(configDir)

  await assert.rejects(
    () => runDelete(ID, {}, deps(configDir, { manifest: manifestBody(), rec: recorder({ failAfter: 0 }) })),
    /server said no/,
  )

  assert.deepEqual(await stateFiles(configDir), ['statekey.json'])
})

test('a manifest that Telegram refuses leaves the local record alone', async () => {
  const configDir = await workspace()
  await unfinished(configDir)
  const rec = recorder({ failOnManifest: true, manifestId: 2000 })

  await assert.rejects(() => runDelete(ID, {}, deps(configDir, { manifest: manifestBody(), rec })), /server said no/)

  assert.deepEqual(await stateFiles(configDir), ['statekey.json'])
})

test('the local record is dropped once the chat is clean', async () => {
  const configDir = await workspace()
  await unfinished(configDir)

  await runDelete(ID, {}, deps(configDir, { manifest: manifestBody(), rec: recorder() }))

  assert.deepEqual(await stateFiles(configDir), [])
})

// --- where the message ids come from ------------------------------------------------

test('an unfinished backup is deleted from its local record alone', async () => {
  const configDir = await workspace()
  await unfinished(configDir, { done: { 1: { msgId: 501 }, 0: { msgId: 500 } } })
  const rec = recorder()

  await runDelete(ID, {}, deps(configDir, { rec }))

  assert.deepEqual(rec.calls, [[500, 501]])
  assert.deepEqual(await stateFiles(configDir), [])
})

test('a chunk only the local record knows about is deleted too', async () => {
  const configDir = await workspace()
  await unfinished(configDir, { done: { 0: { msgId: 1000 }, 9: { msgId: 1999 } } })
  const rec = recorder()

  await runDelete(ID, {}, deps(configDir, { manifest: manifestBody(), rec }))

  assert.deepEqual(rec.calls[0], [1000, 1001, 1002, 1999])
})

test('a backup that is in neither the chat nor the local records is refused', async () => {
  const configDir = await workspace()
  const rec = recorder()

  await assert.rejects(() => runDelete(ID, {}, deps(configDir, { rec })), /no unfinished record/)
  assert.deepEqual(rec.calls, [])
})

test('two local records claiming the same backup are refused rather than guessed between', async () => {
  const configDir = await workspace()
  await unfinished(configDir)
  await saveState('other', { id: ID, chat: '@store', path: '/b.tar', size: 1, mtimeMs: 2, chunkSize: 1, done: {} }, configDir)
  const rec = recorder()

  await assert.rejects(() => runDelete(ID, {}, deps(configDir, { rec })), /will not guess/)
  assert.deepEqual(rec.calls, [])
})

// --- untrusted input ----------------------------------------------------------------

// The test that proves delete does not go through parseManifest: a manifest whose layout is
// wrong is exactly the broken backup somebody wants gone.
test('a manifest too damaged to restore from can still be deleted', async () => {
  const configDir = await workspace()
  const rec = recorder()
  const broken = { ...manifestBody(), size: 999999, v: 7 }

  await runDelete(ID, {}, deps(configDir, { manifest: broken, rec }))

  assert.deepEqual(rec.calls, [[1000, 1001, 1002], [2000]])
})

test('a manifest that is not JSON is refused before anything is deleted', async () => {
  const configDir = await workspace()
  const rec = recorder()

  await assert.rejects(
    () =>
      runDelete(
        ID,
        {},
        deps(configDir, { manifest: {}, rec, readMessageBytes: async () => Buffer.from('{ not json') }),
      ),
    /not valid JSON/,
  )
  assert.deepEqual(rec.calls, [])
})

test('a manifest with a message id that is not a message id is refused whole', async () => {
  const configDir = await workspace()
  const rec = recorder()
  const manifest = manifestBody()
  manifest.chunks[1].msgId = '1001'

  await assert.rejects(() => runDelete(ID, {}, deps(configDir, { manifest, rec })), /chunk 2/)
  assert.deepEqual(rec.calls, [])
})

// The one mistake in this command that cannot be undone: a renamed manifest would name
// another backup's chunks.
test('a manifest describing a different backup is refused', async () => {
  const configDir = await workspace()
  const rec = recorder()

  await assert.rejects(
    () => runDelete(ID, {}, deps(configDir, { manifest: manifestBody({ id: 'telstore-somebody-else' }), rec })),
    /not telstore-20260905-7f3a91/,
  )
  assert.deepEqual(rec.calls, [])
})

test('a manifest that does not name a backup at all is still deleted by its file name', async () => {
  const configDir = await workspace()
  const rec = recorder()
  const manifest = manifestBody()
  delete manifest.id

  await runDelete(ID, {}, deps(configDir, { manifest, rec }))

  assert.deepEqual(rec.calls[0], [1000, 1001, 1002])
})

test('a local record with a message id that is not a message id is refused whole', async () => {
  const configDir = await workspace()
  await unfinished(configDir, { done: { 0: { msgId: 500 }, 1: { msgId: null } } })
  const rec = recorder()

  await assert.rejects(() => runDelete(ID, {}, deps(configDir, { rec })), /chunk 2/)
  assert.deepEqual(rec.calls, [])
})

test('a local record that lists no chunks at all names the file to remove by hand', async () => {
  const configDir = await workspace()
  await unfinished(configDir, { done: 'nonsense' })
  const rec = recorder()

  await assert.rejects(() => runDelete(ID, {}, deps(configDir, { rec })), /statekey\.json/)
  assert.deepEqual(rec.calls, [])
})

test('an unfinished backup that never sent a chunk still drops its record', async () => {
  const configDir = await workspace()
  await unfinished(configDir, { done: {} })
  const rec = recorder()

  await runDelete(ID, {}, deps(configDir, { rec }))

  assert.deepEqual(rec.ids(), [])
  assert.deepEqual(await stateFiles(configDir), [])
})

// --- asking first -------------------------------------------------------------------

test('answering anything but yes deletes nothing', async () => {
  const configDir = await workspace()
  const rec = recorder()

  await assert.rejects(
    () => runDelete(ID, {}, deps(configDir, { manifest: manifestBody(), rec, confirm: async () => false })),
    /Cancelled on request/,
  )
  assert.deepEqual(rec.calls, [])
})

test('--yes does not ask', async () => {
  const configDir = await workspace()
  let asked = false

  await runDelete(
    ID,
    { yes: true },
    deps(configDir, {
      manifest: manifestBody(),
      rec: recorder(),
      confirm: async () => {
        asked = true
        return true
      },
    }),
  )

  assert.equal(asked, false)
})

test('the prompt says the backup cannot be recovered', async () => {
  const configDir = await workspace()
  let question = ''

  await runDelete(
    ID,
    {},
    deps(configDir, {
      manifest: manifestBody(),
      rec: recorder(),
      confirm: async (q) => {
        question = q
        return true
      },
    }),
  )

  assert.match(question, /cannot be recovered/)
  assert.match(question, /\[y\/N\]/)
})

// --- what it says ---------------------------------------------------------------------

test('the summary names the file, its size and its chunk count before asking', async () => {
  const configDir = await workspace()
  const out = collect()

  await runDelete(ID, { yes: true }, deps(configDir, { manifest: manifestBody(), rec: recorder(), out }))

  assert.match(out.text(), /data\.tar/)
  assert.match(out.text(), /1\.2 KB/)
  assert.match(out.text(), /3 chunks/)
})

test('a manifest that cannot say the file name says so rather than printing undefined', async () => {
  const configDir = await workspace()
  const out = collect()
  const manifest = manifestBody()
  manifest.name = null
  manifest.size = 'huge'

  await runDelete(ID, { yes: true }, deps(configDir, { manifest, rec: recorder(), out }))

  assert.doesNotMatch(out.text(), /undefined|null|NaN/)
  assert.match(out.text(), /—/)
})

test('an unfinished backup is announced as unfinished', async () => {
  const configDir = await workspace()
  await unfinished(configDir)
  const out = collect()

  await runDelete(ID, { yes: true }, deps(configDir, { rec: recorder(), out }))

  assert.match(out.text(), /unfinished/)
  assert.match(out.text(), /\/home\/me\/data\.tar/)
})

// A stream record carries the name the backup was given where a file record carries a path,
// so reading only the path describes the file that is sitting right there in the record as
// the placeholder for something nothing could say.
test('a stream record with no manifest is described by its name, not a path it never had', async () => {
  const configDir = await workspace()
  await unfinishedStream(configDir)
  const out = collect()

  await runDelete(ID, { yes: true }, deps(configDir, { rec: recorder(), out }))

  assert.match(out.text(), /File\s+a\.tar/)
  assert.doesNotMatch(out.text(), /File\s+—/)
})

// --- the manifest the chat's own search did not return --------------------------------

// searchManifest asks Telegram's text index, and docs/design/captions.md records that index
// returning nothing for a channel whose documents were all plainly there, with nothing that
// predicts when it happens. A stream run writes the id of the card it sent into its record
// before that record can be left behind, so the one command telstore tells the user to run
// still removes the manifest — otherwise it would advertise a backup whose chunks the same
// run has just taken away.
test('a manifest the chat search cannot find is removed from the record that names it', async () => {
  const configDir = await workspace()
  await unfinishedStream(configDir, { done: { 0: { msgId: 500 } }, manifestMsgId: 900 })
  const rec = recorder()

  await runDelete(ID, { yes: true }, deps(configDir, { rec }))

  // Chunks first, manifest last, exactly as when the search did find it.
  assert.deepEqual(rec.calls, [[500], [900]])
  assert.deepEqual(await stateFiles(configDir), [])
})

// The manifest is the index of the ids under it, so it is not a chunk and must not be counted
// as one: "2 chunk messages" for two chunks and a card is telstore describing the chat wrongly
// in the one report somebody reads closely.
test('a manifest named only by the record is not counted among the chunk messages', async () => {
  const configDir = await workspace()
  await unfinishedStream(configDir, { done: { 0: { msgId: 500 } }, manifestMsgId: 900 })
  const out = collect()

  const result = await runDelete(ID, { yes: true }, deps(configDir, { rec: recorder(), out }))

  assert.equal(result.chunks, 1)
  assert.equal(result.manifestDeleted, true)
  assert.match(out.text(), /1 chunk message/)
  assert.doesNotMatch(out.text(), /2 chunk messages/)
})

// The same rule the chunk ids get, and for the same reason: a message id names something
// about to be destroyed for good, so a record that cannot say it exactly is refused whole.
test('a record whose manifest id is not a message id is refused before anything is deleted', async () => {
  const configDir = await workspace()
  await unfinishedStream(configDir, { manifestMsgId: 0 })
  const rec = recorder()

  await assert.rejects(() => runDelete(ID, {}, deps(configDir, { rec })), /not a message id/)
  assert.deepEqual(rec.calls, [])
})

// Telegram says nothing about an id that was already gone, so a count of ids sent is not a
// count of messages that existed. The summary describes the backup, never a quantity freed.
test('the closing line does not claim to have freed any space', async () => {
  const configDir = await workspace()
  const out = collect()

  await runDelete(ID, { yes: true }, deps(configDir, { manifest: manifestBody(), rec: recorder(), out }))

  assert.doesNotMatch(out.text(), /freed/i)
  assert.match(out.text(), /Done\./)
})

test('silent says nothing at all', async () => {
  const configDir = await workspace()
  const out = collect()

  await runDelete(
    ID,
    { yes: true },
    deps(configDir, { manifest: manifestBody(), rec: recorder(), out, silent: true }),
  )

  assert.equal(out.text(), '')
})

// --- the usual command rituals ---------------------------------------------------------

test('a machine that has never logged in is told to log in, not to pick a chat', async () => {
  const configDir = await tempDir('delete')
  await saveConfig({}, configDir)

  await assert.rejects(() => runDelete(ID, {}, deps(configDir, { rec: recorder() })), /Not logged in/)
})

test('a machine with no destination is told to set one', async () => {
  const configDir = await tempDir('delete')
  await saveConfig({ ...LOGGED_IN }, configDir)

  await assert.rejects(() => runDelete(ID, {}, deps(configDir, { rec: recorder() })), /config chat/)
})

test('--chat points at another chat without changing the stored one', async () => {
  const configDir = await workspace()
  const seen = []

  await runDelete(
    ID,
    { yes: true, chat: '@elsewhere' },
    deps(configDir, {
      manifest: manifestBody(),
      rec: recorder(),
      searchManifest: async (client, peer) => {
        seen.push(peer)
        return { id: 2000, fileName: manifestFileName(ID) }
      },
    }),
  )

  assert.deepEqual(seen, ['@elsewhere'])
})

test('the connection is closed even when the delete fails', async () => {
  const configDir = await workspace()
  let closed = false

  await assert.rejects(
    () =>
      runDelete(
        ID,
        { yes: true },
        deps(configDir, {
          manifest: manifestBody(),
          rec: recorder({ failAfter: 0 }),
          disconnect: async () => {
            closed = true
          },
        }),
      ),
    /server said no/,
  )

  assert.equal(closed, true)
})

// --- a deleted backup must stop being offered as restorable --------------------------

async function unfinishedRestore(configDir, { id = ID, target } = {}) {
  await saveRestore(
    restoreKey(id, target),
    { v: 1, id, target, chat: '@store', size: 1200, chunks: 3, done: 1 },
    configDir,
  )
}

test('deleting a backup drops the restore record that pointed at it', async () => {
  const configDir = await workspace()
  const dir = await tempDir('delete-target')
  const target = `${dir}/out.tar`
  await unfinishedRestore(configDir, { target })

  await runDelete(ID, {}, deps(configDir, { manifest: manifestBody(), rec: recorder() }))

  assert.deepEqual(await findRestores(ID, configDir), [])
})

test('deleting a backup drops every restore record for it, not just the first', async () => {
  const configDir = await workspace()
  const dir = await tempDir('delete-target')
  await unfinishedRestore(configDir, { target: `${dir}/one.tar` })
  await unfinishedRestore(configDir, { target: `${dir}/two.tar` })

  await runDelete(ID, {}, deps(configDir, { manifest: manifestBody(), rec: recorder() }))

  assert.deepEqual(await findRestores(ID, configDir), [])
})

// The .partial is the user's data, not telstore's bookkeeping — delete removes what was
// asked for and nothing else. But after this it can never be completed, so a user who is
// not told is left with gigabytes they have no reason to look for.
test('deleting a backup keeps the .partial and says it can never be finished', async () => {
  const configDir = await workspace()
  const dir = await tempDir('delete-target')
  const target = `${dir}/out.tar`
  await fs.writeFile(`${target}.partial`, 'half a backup')
  await unfinishedRestore(configDir, { target })
  const out = collect()

  await runDelete(ID, {}, deps(configDir, { manifest: manifestBody(), rec: recorder(), out }))

  assert.equal(await fs.readFile(`${target}.partial`, 'utf8'), 'half a backup')
  assert.match(out.text(), new RegExp(`${target}\\.partial`))
  assert.match(out.text(), /Nothing can finish it now/)
  assert.match(out.text(), /delete it when you want the space back/)
})

test('a restore record whose .partial is already gone is dropped without a word about it', async () => {
  const configDir = await workspace()
  const dir = await tempDir('delete-target')
  const out = collect()
  await unfinishedRestore(configDir, { target: `${dir}/out.tar` })

  await runDelete(ID, {}, deps(configDir, { manifest: manifestBody(), rec: recorder(), out }))

  assert.deepEqual(await findRestores(ID, configDir), [])
  assert.doesNotMatch(out.text(), /\.partial/)
})

// --- what the chat itself says is there ---------------------------------------------------
//
// Measured 2026-09-09 against a real account: a stream upload left by a second Ctrl-C put a
// chunk in the chat that its own record never named, and the delete command that run printed
// removed the two ids it knew about, said "Done", and left 12MB behind
// (docs/design/data-integrity.md, and the reasoning in docs/design/delete.md). No fake client
// can produce that race — what it can do is prove delete no longer takes the record's word
// for what is in the chat.

// The day every document below is stamped with: after the day ID carries, so nothing here
// stops the walk by being older than the backup itself.
const DAY = Date.UTC(2026, 8, 6) / 1000

const chunkDoc = (msgId, index, backup = ID) => ({
  id: msgId,
  fileName: chunkFileName(backup, index),
  date: DAY,
})

const cardDoc = (msgId, backup = ID) => ({
  id: msgId,
  fileName: manifestFileName(backup),
  date: DAY,
})

const otherDoc = (msgId, fileName, date = DAY) => ({ id: msgId, fileName, date })

// A chat as iterDocuments hands it over — newest first, and honouring the offsetId and the
// ceiling the caller asked for. Each call is kept, with how many documents the walk actually
// pulled out of it: where the walk stops is the whole point of several tests below, and a
// walk that read the entire chat to reach the same answer would pass every other assertion.
function chatOf(documents) {
  const newestFirst = [...documents].sort((a, b) => b.id - a.id)
  const walks = []

  return {
    walks,
    readDocuments: async function* (client, peer, options = {}) {
      const { max = Infinity, offsetId = 0 } = options
      const walk = { offsetId, max, read: 0 }

      walks.push(walk)

      for (const document of newestFirst) {
        if (offsetId !== 0 && document.id >= offsetId) continue
        if (walk.read >= max) return

        walk.read += 1
        yield document
      }
    },
  }
}

test('a chunk in the chat that the record never named is removed with the rest', async () => {
  const configDir = await workspace()
  const rec = recorder()
  // What the e2e run measured: the record names two, the chat holds three.
  const chat = chatOf([chunkDoc(500, 0), chunkDoc(501, 1), chunkDoc(502, 2)])

  await unfinishedStream(configDir, {
    done: { 0: { msgId: 500, size: 4, sha256: 'x' }, 1: { msgId: 501, size: 4, sha256: 'x' } },
  })

  await runDelete(ID, {}, deps(configDir, { rec, readDocuments: chat.readDocuments }))

  assert.deepEqual(rec.ids(), [500, 501, 502])
})

test('the stray chunk is named before the question that authorises the removal', async () => {
  const configDir = await workspace()
  const out = collect()
  const chat = chatOf([chunkDoc(500, 0), chunkDoc(501, 1)])
  let askedAfter = null

  await unfinishedStream(configDir)

  await runDelete(
    ID,
    {},
    deps(configDir, {
      rec: recorder(),
      out,
      readDocuments: chat.readDocuments,
      confirm: async () => {
        askedAfter = out.text()
        return true
      },
    }),
  )

  assert.match(askedAfter, /1 chunk message of this backup that no manifest and no record/)
  assert.match(askedAfter, /found by reading @store/)
  // And again at the end, where somebody reads what actually happened.
  assert.match(out.text(), /That includes 1 chunk message of this backup/)
})

// The count in that question is the number a person is agreeing to destroy, so the chunk the
// walk found has to be inside it rather than a footnote beside it.
test('the question counts the stray chunk among the messages it is about to remove', async () => {
  const configDir = await workspace()
  const chat = chatOf([chunkDoc(500, 0), chunkDoc(501, 1)])
  let question = null

  await unfinishedStream(configDir)

  await runDelete(
    ID,
    {},
    deps(configDir, {
      rec: recorder(),
      readDocuments: chat.readDocuments,
      confirm: async (text) => {
        question = text
        return true
      },
    }),
  )

  assert.match(question, /Delete the 2 chunk messages it sent/)
})

test('a delete with nothing stray in the chat says nothing new about it', async () => {
  const configDir = await workspace()
  const out = collect()
  const chat = chatOf([chunkDoc(1000, 0), chunkDoc(1001, 1), chunkDoc(1002, 2), cardDoc(2000)])
  const rec = recorder()

  await runDelete(
    ID,
    { yes: true },
    deps(configDir, { manifest: manifestBody(), rec, out, readDocuments: chat.readDocuments }),
  )

  assert.deepEqual(rec.calls, [[1000, 1001, 1002], [2000]])
  assert.doesNotMatch(out.text(), /found by reading/)
  assert.match(out.text(), /^\nDone\. Removed/m)
})

// The walk is bounded by the backup's own messages: telstore sends chunk 0 first and records
// each id as it lands, so the oldest id it knows is the oldest message this backup has in the
// chat and there is nothing of it below. A walk without that floor reads somebody's whole
// archive to find a chunk that was three messages from the top.
test('the walk stops at the oldest message the backup is known to have sent', async () => {
  const configDir = await workspace()
  const chat = chatOf([
    chunkDoc(500, 0),
    chunkDoc(501, 1),
    chunkDoc(502, 2),
    ...Array.from({ length: 50 }, (_, i) => otherDoc(400 - i, `somebody-else-${i}.zip`)),
  ])

  await unfinishedStream(configDir, {
    done: { 0: { msgId: 500, size: 4, sha256: 'x' }, 1: { msgId: 501, size: 4, sha256: 'x' } },
  })

  await runDelete(ID, {}, deps(configDir, { rec: recorder(), readDocuments: chat.readDocuments }))

  assert.equal(chat.walks.length, 1)
  assert.equal(chat.walks[0].read, 3)
})

// A backup's manifest is the last message its run sends, so nothing of that backup is newer
// than the card. Everything posted since belongs to somebody else, and reading it costs a
// request per hundred documents on every delete of an old backup.
test('the walk starts under the card when the chat search found one', async () => {
  const configDir = await workspace()
  const chat = chatOf([
    ...Array.from({ length: 30 }, (_, i) => otherDoc(9000 - i, `newer-${i}.zip`)),
    cardDoc(2000),
    chunkDoc(1000, 0),
    chunkDoc(1001, 1),
    chunkDoc(1002, 2),
  ])

  await runDelete(
    ID,
    { yes: true },
    deps(configDir, { manifest: manifestBody(), rec: recorder(), readDocuments: chat.readDocuments }),
  )

  assert.equal(chat.walks[0].offsetId, 2000)
  assert.equal(chat.walks[0].read, 3)
})

// The one mistake in this command nothing can undo is removing somebody else's message, so
// what belongs to this backup is decided by the file name telstore wrote and by nothing else.
test('the walk leaves alone what is not this backup\'s chunk', async () => {
  const configDir = await workspace()
  const rec = recorder()
  const chat = chatOf([
    chunkDoc(600, 0, 'telstore-20260905-000000'),
    otherDoc(601, `${ID}.partial`),
    otherDoc(602, `${ID}.part0001.bak`),
    otherDoc(603, 'holiday.zip'),
    chunkDoc(604, 3),
    chunkDoc(500, 0),
  ])

  await unfinishedStream(configDir)

  await runDelete(ID, {}, deps(configDir, { rec, readDocuments: chat.readDocuments }))

  assert.deepEqual(rec.ids(), [500, 604])
})

// The chunks go first and the manifest last so an interrupted delete can be finished by
// running it again. A chunk the walk found is a chunk like any other and keeps that order.
test('a stray chunk goes out with the chunks, not after the manifest', async () => {
  const configDir = await workspace()
  const rec = recorder()
  const chat = chatOf([cardDoc(2000), chunkDoc(1500, 3), chunkDoc(1000, 0)])

  await runDelete(
    ID,
    { yes: true },
    deps(configDir, { manifest: manifestBody(), rec, readDocuments: chat.readDocuments }),
  )

  assert.deepEqual(rec.calls, [[1000, 1001, 1002, 1500], [2000]])
})

// Telegram's text index can answer nothing at all about a chat that is plainly full of
// documents (docs/design/captions.md). Before the walk, a delete that hit that took the
// chunks away and left the card advertising a backup restore cannot fulfil.
test('a manifest the search missed is found by the walk and removed last', async () => {
  const configDir = await workspace()
  const rec = recorder()
  const chat = chatOf([cardDoc(2000), chunkDoc(1002, 2), chunkDoc(1001, 1), chunkDoc(1000, 0)])

  await unfinished(configDir, { done: { 0: { msgId: 1000, size: 400, sha256: 'x' } } })

  await runDelete(
    ID,
    {},
    deps(configDir, {
      rec,
      readDocuments: chat.readDocuments,
      searchManifest: async () => null,
      readMessageBytes: async () => serializeManifest(manifestBody()),
    }),
  )

  assert.deepEqual(rec.calls, [[1000, 1001, 1002], [2000]])
})

// Those three chunks are named by the card the walk found on its way past, so none of them is
// a message nothing points at. Counting them before that card had been read would report a
// whole backup as leftovers in the sentence someone reads to decide whether to say yes.
test('chunks named by the manifest the walk found are not called strays', async () => {
  const configDir = await workspace()
  const out = collect()
  const chat = chatOf([cardDoc(2000), chunkDoc(1002, 2), chunkDoc(1001, 1), chunkDoc(1000, 0)])

  await unfinished(configDir, { done: { 0: { msgId: 1000, size: 400, sha256: 'x' } } })

  await runDelete(
    ID,
    { yes: true },
    deps(configDir, {
      rec: recorder(),
      out,
      readDocuments: chat.readDocuments,
      searchManifest: async () => null,
      readMessageBytes: async () => serializeManifest(manifestBody()),
    }),
  )

  assert.doesNotMatch(out.text(), /found by reading/)
})

// Nothing on this machine names these — the record was cleared, or the id was only ever read
// off the line the interrupted run printed. Before the walk this refused outright.
test('chunks in the chat are removed even with no manifest and no record', async () => {
  const configDir = await workspace()
  const rec = recorder()
  const out = collect()
  const chat = chatOf([chunkDoc(501, 1), chunkDoc(500, 0), otherDoc(499, 'holiday.zip')])

  let question = null

  const result = await runDelete(
    ID,
    {},
    deps(configDir, {
      rec,
      out,
      readDocuments: chat.readDocuments,
      confirm: async (text) => {
        question = text
        return true
      },
    }),
  )

  assert.deepEqual(rec.ids(), [500, 501])
  assert.equal(result.stateCleared, false)
  assert.match(out.text(), /Done\. Removed 2 chunk messages of telstore-20260905-7f3a91/)
  // There is no record here to offer to drop, and a question that says otherwise is one
  // whose "yes" means something other than what it asked.
  assert.doesNotMatch(question, /local record/)
  assert.match(question, /Delete the 2 chunk messages it sent\?/)
})

// The floor for a walk that knows no message id of its own is the day the backup id carries,
// with a day of slack under it: nothing that backup sent can be older than the day it was
// made, whatever else is in the chat below.
test('a walk with no id to stop at stops at the day the backup id carries', async () => {
  const configDir = await workspace()
  const chat = chatOf([
    chunkDoc(500, 0),
    otherDoc(499, 'older.zip', Date.UTC(2026, 8, 3) / 1000),
    ...Array.from({ length: 40 }, (_, i) => otherDoc(400 - i, `ancient-${i}.zip`, 0)),
  ])

  await runDelete(ID, { yes: true }, deps(configDir, { rec: recorder(), readDocuments: chat.readDocuments }))

  assert.equal(chat.walks[0].read, 2)
})

// A walk stopped by its own ceiling has not reached the start of the backup and cannot say
// what is behind it. "Done" is a claim of exactly that, so it is not made.
test('a walk stopped by its ceiling does not report the backup as done', async () => {
  const configDir = await workspace()
  const out = collect()
  const rec = recorder()
  const chat = chatOf([
    chunkDoc(601, 4),
    otherDoc(600, 'a.zip'),
    otherDoc(599, 'b.zip'),
    chunkDoc(500, 0),
  ])

  await unfinishedStream(configDir)

  await runDelete(
    ID,
    { yes: true },
    deps(configDir, { rec, out, readDocuments: chat.readDocuments, maxDocuments: 3 }),
  )

  assert.deepEqual(rec.ids(), [500, 601])
  assert.doesNotMatch(out.text(), /Done\./)
  assert.match(out.text(), /read the newest 3 documents of @store without reaching the start/)
  assert.match(out.text(), /carries that id in its file name/)
})

test('a walk that reached the backup\'s own floor says the removal is done', async () => {
  const configDir = await workspace()
  const out = collect()
  const chat = chatOf([chunkDoc(501, 1), chunkDoc(500, 0)])

  await unfinishedStream(configDir)

  await runDelete(
    ID,
    { yes: true },
    deps(configDir, { rec: recorder(), out, readDocuments: chat.readDocuments }),
  )

  assert.match(out.text(), /Done\. Removed/)
  assert.doesNotMatch(out.text(), /without reaching the start/)
})

test('an id nothing in the chat and nothing on disk knows about is still refused', async () => {
  const configDir = await workspace()
  const chat = chatOf([otherDoc(9000, 'holiday.zip')])

  await assert.rejects(
    () => runDelete(ID, {}, deps(configDir, { rec: recorder(), readDocuments: chat.readDocuments })),
    /No backup telstore-20260905-7f3a91 found in @store, and no unfinished record/,
  )
})

// "Not found" over a chat the walk could not read to the bottom of is a claim about
// somewhere it never looked.
test('an id not found by a walk that ran out of budget says how far it read', async () => {
  const configDir = await workspace()
  const chat = chatOf([otherDoc(9000, 'a.zip'), otherDoc(8999, 'b.zip'), otherDoc(8998, 'c.zip')])

  await assert.rejects(
    () =>
      runDelete(
        ID,
        {},
        deps(configDir, { rec: recorder(), readDocuments: chat.readDocuments, maxDocuments: 2 }),
      ),
    /the newest 2 documents were read/,
  )
})

// Silence over a chat being read page by page is the hang this project refuses everywhere
// else; a line drawn and wiped inside 400ms is a flicker rather than information.
test('a walk long enough to look like a hang says what it is reading', async () => {
  const configDir = await workspace()
  const drawn = []
  let clock = 1000

  await unfinishedStream(configDir)

  await runDelete(
    ID,
    { yes: true },
    deps(configDir, {
      rec: recorder(),
      readDocuments: async function* () {
        for (let i = 0; i < 200; i += 1) {
          clock += 10
          yield otherDoc(9000 - i, `filler-${i}.zip`)
        }
      },
      writeProgress: (text) => drawn.push(text),
      now: () => clock,
    }),
  )

  assert.ok(drawn.length > 0, 'expected the walk to say something')
  assert.ok(drawn.some((text) => /Reading @store/.test(text)))
  assert.match(drawn.at(-1), /^\r +\r$/)
})

test('a walk short enough to go unnoticed draws nothing', async () => {
  const configDir = await workspace()
  const drawn = []
  const chat = chatOf([chunkDoc(500, 0)])

  await unfinishedStream(configDir)

  await runDelete(
    ID,
    { yes: true },
    deps(configDir, {
      rec: recorder(),
      readDocuments: chat.readDocuments,
      writeProgress: (text) => drawn.push(text),
      now: () => 1000,
    }),
  )

  assert.deepEqual(drawn, [])
})

// The ceiling and the floor can land on the same document: a walk that reached the start of
// the backup with its last permitted read has seen everything there is, and reporting that as
// a removal it could not finish would send somebody looking for chunks that are not there.
test('a walk that reaches the floor on its last permitted read is still complete', async () => {
  const configDir = await workspace()
  const out = collect()
  const chat = chatOf([
    chunkDoc(502, 2),
    chunkDoc(501, 1),
    chunkDoc(500, 0),
    otherDoc(499, 'older.zip'),
  ])

  await unfinishedStream(configDir, {
    done: { 0: { msgId: 500, size: 4, sha256: 'x' }, 1: { msgId: 501, size: 4, sha256: 'x' } },
  })

  await runDelete(
    ID,
    { yes: true },
    deps(configDir, { rec: recorder(), out, readDocuments: chat.readDocuments, maxDocuments: 3 }),
  )

  assert.equal(chat.walks[0].read, 3)
  assert.match(out.text(), /Done\. Removed/)
  assert.doesNotMatch(out.text(), /without reaching the start/)
})
