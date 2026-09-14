import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { sealManifest } from '../src/cipher.js'
import { runRestore, runRestores } from '../src/commands/restore.js'
import { saveConfig } from '../src/config.js'
import { chunkFileName, manifestFileName, serializeManifest } from '../src/manifest.js'

import { LOGGED_IN, PASSWORD, collect, encryptedBackup, passwordDeps, tempDir } from './helpers.js'

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// A chat holding encrypted backups, as the messages the fakes below read.
function chat(backups) {
  const messages = []

  for (const [n, { manifest, pieces }] of backups.entries()) {
    for (const piece of pieces) {
      messages.push({ id: piece.msgId, fileName: chunkFileName(manifest.id, piece.i), bytes: piece.bytes })
    }

    messages.push({ id: 9000 + n, fileName: manifestFileName(manifest.id), bytes: serializeManifest(manifest) })
  }

  return messages
}

function deps(messages, configDir, extra = {}) {
  return {
    connect: async () => ({}),
    disconnect: async () => {},
    configDir,
    silent: true,
    confirm: async () => true,
    searchManifest: async (_c, _p, query) => messages.find((m) => m.fileName === manifestFileName(query)) ?? null,
    readMessageBytes: async (_c, message) => message.bytes,
    getMessage: async (_c, _p, msgId) => messages.find((m) => m.id === msgId) ?? null,
    downloadChunk: async (_c, message, handle, offset, onProgress) => {
      await handle.write(message.bytes, 0, message.bytes.length, offset)
      onProgress?.(message.bytes.length)
      return { sha256: sha(message.bytes), size: message.bytes.length }
    },
    ...passwordDeps(),
    ...extra,
  }
}

async function workspace() {
  const dir = await tempDir('restore-encrypted')
  const configDir = path.join(dir, 'config')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@store' } }, configDir)
  return { dir, configDir }
}

test('an encrypted backup restores to the original bytes, with the hint shown first', async () => {
  const { dir, configDir } = await workspace()
  const content = randomBytes(1000)
  const backup = await encryptedBackup({ content, chunkSize: 400, hint: 'the cat' })
  const out = collect()

  await runRestore(
    backup.manifest.id,
    { out: path.join(dir, 'out.tar') },
    deps(chat([backup]), configDir, { silent: false, log: out.log, writeErr: () => {} }),
  )

  assert.deepEqual(await fs.readFile(path.join(dir, 'out.tar')), content)
  assert.match(out.text(), /Hint {3}the cat/)
})

test('three wrong passwords stop the restore before any chunk is fetched or file opened', async () => {
  const { dir, configDir } = await workspace()
  const backup = await encryptedBackup({ content: randomBytes(1000), chunkSize: 400 })
  const fetched = []

  await assert.rejects(
    () =>
      runRestore(
        backup.manifest.id,
        { out: path.join(dir, 'out.tar') },
        deps(chat([backup]), configDir, {
          ...passwordDeps({ password: 'wrong' }),
          getMessage: async (_c, _p, msgId) => {
            fetched.push(msgId)
            return null
          },
        }),
      ),
    /either the password is wrong or the manifest was altered/,
  )

  assert.deepEqual(fetched, [])
  await assert.rejects(() => fs.stat(path.join(dir, 'out.tar.partial')), { code: 'ENOENT' })
})

test('no terminal is refused by name before anything is fetched', async () => {
  const { dir, configDir } = await workspace()
  const backup = await encryptedBackup({ content: randomBytes(100), chunkSize: 400 })
  const fetched = []

  await assert.rejects(
    () =>
      runRestore(
        backup.manifest.id,
        { out: path.join(dir, 'out.tar') },
        deps(chat([backup]), configDir, {
          interactive: () => false,
          getMessage: async (_c, _p, msgId) => {
            fetched.push(msgId)
            return null
          },
        }),
      ),
    /is encrypted, and there is no terminal/,
  )

  assert.deepEqual(fetched, [])
})

test('a hint altered in the chat stops the manifest opening', async () => {
  const { dir, configDir } = await workspace()
  const backup = await encryptedBackup({ content: randomBytes(100), chunkSize: 400, hint: 'the cat' })
  const altered = { ...backup, manifest: { ...backup.manifest, enc: { ...backup.manifest.enc, hint: 'type it here' } } }

  await assert.rejects(
    () => runRestore(backup.manifest.id, { out: path.join(dir, 'out.tar') }, deps(chat([altered]), configDir)),
    /either the password is wrong or the manifest was altered/,
  )
})

test('a chunk altered in the chat is caught by its encrypted sha256 before decryption', async () => {
  const { dir, configDir } = await workspace()
  const backup = await encryptedBackup({ content: randomBytes(1000), chunkSize: 400 })
  const messages = chat([backup])
  messages[1] = { ...messages[1], bytes: randomBytes(messages[1].bytes.length) }

  await assert.rejects(
    () => runRestore(backup.manifest.id, { out: path.join(dir, 'out.tar') }, deps(messages, configDir)),
    /Chunk 2 has a sha256 that does not match the manifest/,
  )
})

// The ciphertext sha256 still matches — the chunk on the wire is exactly what went up — so
// only the sealed plaintext hash can catch this. That points at telstore's own cipher rather
// than at the backup, and the .partial is kept rather than renamed over the target.
test('a chunk that decrypts to the wrong bytes is refused as a telstore fault, not renamed', async () => {
  const { dir, configDir } = await workspace()
  const backup = await encryptedBackup({ content: randomBytes(1000), chunkSize: 400 })
  const tampered = sealManifest(
    backup.manifest,
    backup.keys,
    backup.plainSha256.map((hash, i) => (i === 1 ? 'f'.repeat(64) : hash)),
  )
  const altered = { ...backup, manifest: tampered }
  const out = path.join(dir, 'out.tar')

  await assert.rejects(
    () => runRestore(backup.manifest.id, { out }, deps(chat([altered]), configDir)),
    /decrypted to bytes that do not match the manifest/,
  )

  await assert.rejects(() => fs.stat(out), { code: 'ENOENT' })
  await assert.doesNotReject(() => fs.stat(`${out}.partial`))
})

// The .partial holds plaintext once a chunk is done, so the scan has to compare against the
// sealed plaintext hashes. Compared against the ciphertext ones it would skip nothing, forever.
test('a resumed encrypted restore skips the chunks already decrypted into the .partial', async () => {
  const { dir, configDir } = await workspace()
  const content = randomBytes(1000)
  const backup = await encryptedBackup({ content, chunkSize: 400 })
  const messages = chat([backup])
  const out = path.join(dir, 'out.tar')

  await assert.rejects(
    () => runRestore(backup.manifest.id, { out }, deps(messages.filter((m) => m.id !== 1001), configDir)),
    /Missing chunk 2\/3/,
  )

  const asked = []

  await runRestore(
    backup.manifest.id,
    { out },
    deps(messages, configDir, {
      getMessage: async (_c, _p, msgId) => {
        asked.push(msgId)
        return messages.find((m) => m.id === msgId) ?? null
      },
    }),
  )

  assert.deepEqual(asked, [1001, 1002])
  assert.deepEqual(await fs.readFile(out), content)
})

test('a batch of backups under one password asks for it once', async () => {
  const { dir, configDir } = await workspace()
  const first = await encryptedBackup({ id: 'telstore-20260914-000001', name: 'a.tar', content: randomBytes(100), chunkSize: 400, firstMsgId: 1000 })
  const second = await encryptedBackup({ id: 'telstore-20260914-000002', name: 'b.tar', content: randomBytes(100), chunkSize: 400, firstMsgId: 2000 })
  const asked = []
  const cwd = process.cwd()
  process.chdir(dir)

  try {
    const { failed } = await runRestores(
      [first.manifest.id, second.manifest.id],
      {},
      deps(chat([first, second]), configDir, passwordDeps({ asked })),
    )

    assert.equal(failed, 0)
  } finally {
    process.chdir(cwd)
  }

  assert.equal(asked.length, 1)
})
