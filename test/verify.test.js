import test from 'node:test'
import assert from 'node:assert/strict'

import { Api } from 'teleproto'
import { returnBigInt } from 'teleproto/Helpers.js'

import { runVerify } from '../src/commands/verify.js'
import { saveConfig } from '../src/config.js'
import { buildManifest, chunkFileName, manifestFileName, serializeManifest } from '../src/manifest.js'
import { LOGGED_IN, collect, tempDir } from './helpers.js'

const ID = 'telstore-20260905-7f3a91'

// The messages verify reads are built the way teleproto hands them over — a real
// DocumentAttributeFilename, a size that arrives as a BigInteger — because a fake shaped
// the convenient way is exactly the blindness docs/design/testing-blind-spots.md is about.
function chunkMessage({ id, fileName, size }) {
  return {
    id,
    media: {
      document: {
        size: returnBigInt(size),
        attributes: [new Api.DocumentAttributeFilename({ fileName })],
      },
    },
  }
}

function fakeBackup({ chunkSize = 400, total = 1000 } = {}) {
  const chunks = []
  const documents = new Map()

  for (let offset = 0, i = 0; offset < total; offset += chunkSize, i += 1) {
    const size = Math.min(chunkSize, total - offset)
    const msgId = 1000 + i

    chunks.push({ i, msgId, size, sha256: 'a'.repeat(64) })
    documents.set(msgId, chunkMessage({ id: msgId, fileName: chunkFileName(ID, i), size }))
  }

  const manifest = buildManifest({ id: ID, name: 'data.tar', size: total, chunkSize, chunks })

  return { manifest, manifestBytes: serializeManifest(manifest), documents }
}

async function workspace() {
  const configDir = await tempDir('verify')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@store' } }, configDir)
  return configDir
}

function deps(backup, configDir, out, { manifestBytes = null, damage = () => {} } = {}) {
  const documents = new Map(backup.documents)
  damage(documents)

  return {
    configDir,
    log: out.log,
    writeErr: () => {},
    connect: async () => ({}),
    disconnect: async () => {},
    retryOptions: { attempts: 1 },
    searchManifest: async (client, peer, query) =>
      query === ID ? { id: 2000, fileName: manifestFileName(ID) } : null,
    readMessageBytes: async () => manifestBytes ?? backup.manifestBytes,
    getDocuments: async (client, peer, ids, options) => {
      // Batched in hundreds like the real one, so what verify hears about its progress is
      // what Telegram would have told it.
      for (let done = 0; done < ids.length; done += 100) {
        options?.onBatch?.(Math.min(done + 100, ids.length), ids.length)
      }

      return new Map(ids.filter((id) => documents.has(id)).map((id) => [id, documents.get(id)]))
    },
  }
}

test('a backup whose chunks are all in the chat verifies', async () => {
  const backup = fakeBackup()
  const out = collect()

  const result = await runVerify(ID, {}, deps(backup, await workspace(), out))

  assert.deepEqual(result, { id: ID, name: 'data.tar', chunks: 3, damaged: [] })
  assert.match(out.text(), /3 chunks present, at the sizes the manifest records\./)
})

// The one thing this command must never be read as saying. It checks that the chunks are
// still there and still the right length; only downloading them proves what is inside.
test('verifying says out loud that it did not read the chunks', async () => {
  const backup = fakeBackup()
  const out = collect()

  await runVerify(ID, {}, deps(backup, await workspace(), out))

  assert.match(out.text(), /does not download them, so it cannot prove their contents/)
})

test('a chunk message that is no longer in the chat is named', async () => {
  const backup = fakeBackup()
  const out = collect()

  const result = await runVerify(
    ID,
    {},
    deps(backup, await workspace(), out, { damage: (docs) => docs.delete(1001) }),
  )

  assert.equal(result.damaged.length, 1)
  assert.match(out.text(), /Chunk 2\/3 is gone: message 1001 is no longer in @store\./)
  assert.match(out.text(), /3 chunks checked, 1 damaged\. This backup cannot be restored\./)
})

test('a chunk whose document is the wrong length is named', async () => {
  const backup = fakeBackup()
  const out = collect()

  const result = await runVerify(
    ID,
    {},
    deps(backup, await workspace(), out, {
      damage: (docs) =>
        docs.set(1001, chunkMessage({ id: 1001, fileName: chunkFileName(ID, 1), size: 399 })),
    }),
  )

  assert.equal(result.damaged.length, 1)
  assert.match(out.text(), /Chunk 2\/3 is 399 bytes in the chat, the manifest records 400\./)
})

// The file name is the one thing telstore itself wrote, so a chunk carrying somebody else's
// is a message the manifest is pointing at by mistake.
test('a chunk message carrying another file name is named', async () => {
  const backup = fakeBackup()
  const out = collect()

  const result = await runVerify(
    ID,
    {},
    deps(backup, await workspace(), out, {
      damage: (docs) =>
        docs.set(1001, chunkMessage({ id: 1001, fileName: 'holiday.jpg', size: 400 })),
    }),
  )

  assert.equal(result.damaged.length, 1)
  assert.match(
    out.text(),
    /Chunk 2\/3 is message 1001, which carries the file name "holiday.jpg" rather than/,
  )
})

test('a chunk message with no file attached is named', async () => {
  const backup = fakeBackup()
  const out = collect()

  const result = await runVerify(
    ID,
    {},
    deps(backup, await workspace(), out, { damage: (docs) => docs.set(1001, { id: 1001 }) }),
  )

  assert.equal(result.damaged.length, 1)
  assert.match(out.text(), /Chunk 2\/3 is message 1001, which has no file attached\./)
})

test('every damaged chunk is named, not just the first', async () => {
  const backup = fakeBackup()
  const out = collect()

  const result = await runVerify(
    ID,
    {},
    deps(backup, await workspace(), out, {
      damage: (docs) => {
        docs.delete(1000)
        docs.delete(1002)
      },
    }),
  )

  assert.equal(result.damaged.length, 2)
  assert.match(out.text(), /Chunk 1\/3 is gone/)
  assert.match(out.text(), /Chunk 3\/3 is gone/)
})

test('a backup with no manifest in the chat is refused by name', async () => {
  const backup = fakeBackup()
  const out = collect()

  await assert.rejects(
    runVerify('telstore-20260101-000000', {}, deps(backup, await workspace(), out)),
    /No backup telstore-20260101-000000 found in @store/,
  )
})

// A manifest that fails its layout checks answers this command's question already: restore
// would refuse it, so verify says so in the manifest's own words rather than inventing new ones.
test('a manifest that fails its layout checks is refused in parseManifest words', async () => {
  const backup = fakeBackup()
  const broken = { ...backup.manifest, size: 999 }
  const out = collect()

  await assert.rejects(
    runVerify(
      ID,
      {},
      deps(backup, await workspace(), out, {
        manifestBytes: serializeManifest(broken),
      }),
    ),
    /Chunk sizes add up to 1000, but the manifest records a file size of 999\./,
  )
})

test('verify closes the connection it opened', async () => {
  const backup = fakeBackup()
  const out = collect()
  let closed = 0

  await runVerify(ID, {}, {
    ...deps(backup, await workspace(), out),
    disconnect: async () => {
      closed += 1
    },
  })

  assert.equal(closed, 1)
})

// The manifest is found by the file name telstore itself wrote, so a body naming another
// backup is a file that was renamed or replaced. Its message ids point at somebody else's
// chunks, and verifying those would answer a question about the wrong backup.
test('a manifest whose body names another backup is refused', async () => {
  const backup = fakeBackup()
  const out = collect()

  await assert.rejects(
    runVerify(
      ID,
      {},
      deps(backup, await workspace(), out, {
        manifestBytes: serializeManifest({ ...backup.manifest, id: 'telstore-20260101-aaaaaa' }),
      }),
    ),
    /describes backup "telstore-20260101-aaaaaa", not telstore-20260905-7f3a91/,
  )
})

// A ten-thousand-chunk backup is a hundred requests, one at a time. This project refuses to
// let a wait look like a hang anywhere else, and a verify that prints its header and then
// says nothing for half a minute is exactly that.
test('a backup too big to ask about in one request says how far it has got', async () => {
  const backup = fakeBackup({ chunkSize: 400, total: 400 * 150 })
  const out = collect()
  const errors = []

  const result = await runVerify(ID, {}, {
    ...deps(backup, await workspace(), out),
    writeErr: (line) => errors.push(line),
  })

  assert.equal(result.chunks, 150)
  assert.match(errors.join(''), /Checking chunk messages 100\/150/)
})

// Three chunks arrive in one request, and a progress line about one request is noise.
test('a backup small enough for one request says nothing about progress', async () => {
  const backup = fakeBackup()
  const out = collect()
  const errors = []

  await runVerify(ID, {}, {
    ...deps(backup, await workspace(), out),
    writeErr: (line) => errors.push(line),
  })

  assert.equal(errors.join(''), '')
})
