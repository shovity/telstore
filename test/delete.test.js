import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

import { runDelete } from '../src/commands/delete.js'
import { saveConfig } from '../src/config.js'
import { buildManifest, manifestFileName, serializeManifest } from '../src/manifest.js'
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
