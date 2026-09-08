import test from 'node:test'
import assert from 'node:assert/strict'

import { Api } from 'teleproto'
import { returnBigInt } from 'teleproto/Helpers.js'

import { runVerifies } from '../src/commands/verify.js'
import { saveConfig } from '../src/config.js'
import { buildManifest, chunkFileName, manifestFileName, serializeManifest } from '../src/manifest.js'
import { LOGGED_IN, collect, tempDir } from './helpers.js'

// A chat holding several finished backups, each with its own chunks and its own manifest.
function fakeChat(count) {
  const backups = []
  const documents = new Map()

  for (let n = 0; n < count; n += 1) {
    const id = `telstore-2026090${n + 1}-00000${n + 1}`
    const chunks = []

    for (let i = 0; i < 2; i += 1) {
      const msgId = 1000 + n * 10 + i

      chunks.push({ i, msgId, size: 400, sha256: 'a'.repeat(64) })
      documents.set(msgId, {
        id: msgId,
        media: {
          document: {
            size: returnBigInt(400),
            attributes: [new Api.DocumentAttributeFilename({ fileName: chunkFileName(id, i) })],
          },
        },
      })
    }

    backups.push({
      id,
      bytes: serializeManifest(
        buildManifest({ id, name: `data-${n}.tar`, size: 800, chunkSize: 400, chunks }),
      ),
    })
  }

  return { backups, documents, ids: backups.map((b) => b.id) }
}

async function workspace() {
  const configDir = await tempDir('verifies')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@store' } }, configDir)
  return configDir
}

function deps(chat, configDir, out, { hidden = [], gone = [] } = {}) {
  const visible = chat.backups.filter((b) => !hidden.includes(b.id))
  let connects = 0

  return {
    configDir,
    connects: () => connects,
    log: out.log,
    writeErr: () => {},
    connect: async () => {
      connects += 1
      return {}
    },
    disconnect: async () => {},
    retryOptions: { attempts: 1 },
    searchManifest: async (client, peer, query) => {
      const backup = visible.find((b) => b.id === query)
      return backup ? { id: backup.id, fileName: manifestFileName(query) } : null
    },
    readMessageBytes: async (client, message) =>
      visible.find((b) => b.id === message.id).bytes,
    getDocuments: async (client, peer, ids) =>
      new Map(
        ids
          .filter((id) => chat.documents.has(id) && !gone.includes(id))
          .map((id) => [id, chat.documents.get(id)]),
      ),
  }
}

test('several ids are verified over a single connection', async () => {
  const chat = fakeChat(3)
  const out = collect()
  const d = deps(chat, await workspace(), out)

  const { results, failed } = await runVerifies(chat.ids, {}, d)

  assert.equal(d.connects(), 1)
  assert.equal(failed, 0)
  assert.deepEqual(results.map((r) => r.id), chat.ids)
})

test('a batch names every id in its summary, verified or not', async () => {
  const chat = fakeChat(3)
  const out = collect()

  await runVerifies(chat.ids, {}, deps(chat, await workspace(), out, { gone: [1010] }))

  assert.match(out.text(), /3 backups: 2 verified, 1 failed\./)
  for (const id of chat.ids) assert.match(out.text(), new RegExp(id))
})

test('a damaged backup makes the batch report a failure', async () => {
  const chat = fakeChat(3)
  const out = collect()

  const { failed } = await runVerifies(
    chat.ids,
    {},
    deps(chat, await workspace(), out, { gone: [1010] }),
  )

  assert.equal(failed, 1)
  assert.match(out.text(), /1 chunk damaged/)
})

// verify destroys nothing, so an id nobody can find is one bad row rather than a reason to
// refuse the whole run — the other ids are exactly the ones somebody is checking on.
test('an id with no manifest is one failed row and the rest still run', async () => {
  const chat = fakeChat(3)
  const out = collect()

  const { results, failed } = await runVerifies(
    chat.ids,
    {},
    deps(chat, await workspace(), out, { hidden: [chat.ids[1]] }),
  )

  assert.equal(failed, 1)
  assert.match(results[1].error, /No backup telstore-20260902-000002 found in @store/)
  assert.equal(results[2].damaged.length, 0)
})

test('an id named twice is refused before anything is asked', async () => {
  const chat = fakeChat(2)
  const out = collect()
  const d = deps(chat, await workspace(), out)

  await assert.rejects(
    runVerifies([chat.ids[0], chat.ids[1], chat.ids[0]], {}, d),
    /telstore-20260901-000001 is named twice/,
  )
  assert.equal(d.connects(), 0)
})

// One id keeps its own wording: a summary about one backup repeats what the lines above it
// already said.
test('one id prints no batch summary', async () => {
  const chat = fakeChat(1)
  const out = collect()

  const { failed } = await runVerifies(chat.ids, {}, deps(chat, await workspace(), out))

  assert.equal(failed, 0)
  assert.doesNotMatch(out.text(), /1 backups:/)
})

test('one damaged id still carries out as a failure', async () => {
  const chat = fakeChat(1)
  const out = collect()

  const { failed } = await runVerifies(
    chat.ids,
    {},
    deps(chat, await workspace(), out, { gone: [1000] }),
  )

  assert.equal(failed, 1)
})

test('a batch refuses to start without a login', async () => {
  const chat = fakeChat(2)
  const configDir = await tempDir('verifies-nologin')
  await saveConfig({ settings: { chat: '@store' } }, configDir)
  const out = collect()

  await assert.rejects(runVerifies(chat.ids, {}, deps(chat, configDir, out)), /telstore login/)
})
