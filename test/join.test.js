import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { runJoin } from '../src/commands/join.js'
import { sealManifest } from '../src/cipher.js'
import { buildManifest, chunkFileName, manifestFileName, serializeManifest } from '../src/manifest.js'

import { collect, encryptedBackup, passwordDeps, tempDir } from './helpers.js'

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

// What a person has after downloading one backup by hand from Telegram web: every chunk and
// the manifest side by side in one folder, under the names telstore gave them.
async function downloadedBackup({
  id = 'telstore-20260905-7f3a91',
  name = 'data.tar',
  chunkSize = 400,
  total = 1000,
  manifestFields = {},
} = {}) {
  const dir = await tempDir('join-src')
  const content = randomBytes(total)
  const chunks = []

  for (let offset = 0, i = 0; offset < total; offset += chunkSize, i += 1) {
    const bytes = content.subarray(offset, Math.min(offset + chunkSize, total))
    await fs.writeFile(path.join(dir, chunkFileName(id, i)), bytes)
    chunks.push({ i, msgId: 1000 + i, size: bytes.length, sha256: sha(bytes) })
  }

  const manifest = { ...buildManifest({ id, name, size: total, chunkSize, chunks }), ...manifestFields }
  const manifestPath = path.join(dir, manifestFileName(id))
  await fs.writeFile(manifestPath, serializeManifest(manifest))

  return { id, dir, content, manifest, manifestPath }
}

function quiet(overrides = {}) {
  return {
    confirm: async () => {
      throw new Error('confirm should not have been asked')
    },
    log: () => {},
    writeErr: () => {},
    ...overrides,
  }
}

async function exists(file) {
  try {
    await fs.stat(file)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

test('join reassembles the chunks byte for byte into --out', async () => {
  const backup = await downloadedBackup()
  const out = path.join(await tempDir('join-out'), 'restored.tar')
  const output = collect()

  const result = await runJoin(backup.manifestPath, { out }, quiet({ log: output.log }))

  assert.deepEqual(await fs.readFile(out), backup.content)
  assert.deepEqual(result, { path: out, size: backup.content.length })
  assert.equal(await exists(`${out}.joining`), false)
  assert.match(output.text(), /Done\. Wrote .* to .*restored\.tar/)
})

test('without --out the file takes the name in the manifest, in the working directory', async () => {
  const backup = await downloadedBackup({ name: 'photos.zip' })
  const cwd = await tempDir('join-cwd')

  const result = await runJoin(backup.manifestPath, {}, quiet({ cwd }))

  assert.equal(result.path, path.join(cwd, 'photos.zip'))
  assert.deepEqual(await fs.readFile(result.path), backup.content)
})

test('a single-chunk backup joins too', async () => {
  const backup = await downloadedBackup({ total: 300, chunkSize: 400 })
  const out = path.join(await tempDir('join-out'), 'one.bin')

  await runJoin(backup.manifestPath, { out }, quiet())

  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('every missing chunk is named at once, and nothing is written', async () => {
  const backup = await downloadedBackup({ total: 2000, chunkSize: 400 })
  await fs.rm(path.join(backup.dir, chunkFileName(backup.id, 1)))
  await fs.rm(path.join(backup.dir, chunkFileName(backup.id, 3)))
  const out = path.join(await tempDir('join-out'), 'restored.tar')

  await assert.rejects(runJoin(backup.manifestPath, { out }, quiet()), (err) => {
    assert.match(err.message, new RegExp(`${chunkFileName(backup.id, 1).replace(/\./g, '\\.')}`))
    assert.match(err.message, new RegExp(`${chunkFileName(backup.id, 3).replace(/\./g, '\\.')}`))
    assert.match(err.message, /2 of 5 chunks/)
    return true
  })

  assert.equal(await exists(out), false)
  assert.equal(await exists(`${out}.joining`), false)
})

test('a chunk at the wrong size is refused before anything is written', async () => {
  const backup = await downloadedBackup()
  const chunk = path.join(backup.dir, chunkFileName(backup.id, 0))
  await fs.writeFile(chunk, randomBytes(123))
  const out = path.join(await tempDir('join-out'), 'restored.tar')

  await assert.rejects(runJoin(backup.manifestPath, { out }, quiet()), (err) => {
    assert.match(err.message, /123 bytes/)
    assert.match(err.message, /400 bytes/)
    assert.ok(err.message.includes(chunkFileName(backup.id, 0)))
    return true
  })

  assert.equal(await exists(out), false)
  assert.equal(await exists(`${out}.joining`), false)
})

test('a chunk whose bytes do not match its sha256 leaves no file behind', async () => {
  const backup = await downloadedBackup()
  // Same length, different bytes: the size check passes and only the hash can see it.
  await fs.writeFile(path.join(backup.dir, chunkFileName(backup.id, 1)), randomBytes(400))
  const out = path.join(await tempDir('join-out'), 'restored.tar')

  await assert.rejects(runJoin(backup.manifestPath, { out }, quiet()), (err) => {
    assert.match(err.message, /sha256/)
    assert.ok(err.message.includes(chunkFileName(backup.id, 1)))
    return true
  })

  assert.equal(await exists(out), false)
  assert.equal(await exists(`${out}.joining`), false)
})

test('an existing file is overwritten only after a yes', async () => {
  const backup = await downloadedBackup()
  const out = path.join(await tempDir('join-out'), 'restored.tar')
  await fs.writeFile(out, 'keep me')

  const asked = []
  await assert.rejects(
    runJoin(backup.manifestPath, { out }, quiet({ confirm: async (q) => (asked.push(q), false) })),
    /Cancelled/,
  )
  assert.equal(await fs.readFile(out, 'utf8'), 'keep me')
  assert.match(asked[0], /already exists/)

  await runJoin(backup.manifestPath, { out }, quiet({ confirm: async () => true }))
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('a restore .partial for the same target is left alone', async () => {
  const backup = await downloadedBackup()
  const out = path.join(await tempDir('join-out'), 'restored.tar')
  await fs.writeFile(`${out}.partial`, 'a restore in progress')

  await runJoin(backup.manifestPath, { out }, quiet())

  assert.equal(await fs.readFile(`${out}.partial`, 'utf8'), 'a restore in progress')
})

test('the message ids are not needed, so a manifest without them still joins', async () => {
  const backup = await downloadedBackup()
  const manifest = { ...backup.manifest, chunks: backup.manifest.chunks.map(({ msgId, ...rest }) => rest) }
  await fs.writeFile(backup.manifestPath, serializeManifest(manifest))
  const out = path.join(await tempDir('join-out'), 'restored.tar')

  await runJoin(backup.manifestPath, { out }, quiet())

  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('a manifest that fails the layout checks is refused in parseManifest words', async () => {
  const backup = await downloadedBackup({ manifestFields: { size: 999 } })
  const out = path.join(await tempDir('join-out'), 'restored.tar')

  await assert.rejects(runJoin(backup.manifestPath, { out }, quiet()), /Chunk sizes add up to 1000/)
  assert.equal(await exists(out), false)
})

test('a backup id that is not a plain name is refused rather than followed as a path', async () => {
  const backup = await downloadedBackup({ manifestFields: { id: '../elsewhere' } })
  const out = path.join(await tempDir('join-out'), 'restored.tar')

  await assert.rejects(runJoin(backup.manifestPath, { out }, quiet()), /backup id/)
})

test('a manifest path that does not exist says which one', async () => {
  const missing = path.join(await tempDir('join-src'), 'nope.manifest.json')

  await assert.rejects(runJoin(missing, {}, quiet()), (err) => {
    assert.ok(err.message.includes(missing))
    return true
  })
})

test('join names its temporary file while it writes and unnames it when done', async () => {
  const backup = await downloadedBackup()
  const out = path.join(await tempDir('join-out'), 'restored.tar')
  const seen = []

  await runJoin(backup.manifestPath, { out }, quiet({ onTempChunk: (file) => seen.push(file) }))

  assert.deepEqual(seen, [`${out}.joining`, null])
})

async function downloadedEncrypted(content) {
  const dir = await tempDir('join-encrypted')
  const { manifest, pieces } = await encryptedBackup({ content, chunkSize: 400 })

  for (const piece of pieces) await fs.writeFile(path.join(dir, chunkFileName(manifest.id, piece.i)), piece.bytes)

  const manifestPath = path.join(dir, manifestFileName(manifest.id))
  await fs.writeFile(manifestPath, serializeManifest(manifest))

  return { dir, manifestPath }
}

test('an encrypted backup joins to its plaintext', async () => {
  const content = randomBytes(1000)
  const backup = await downloadedEncrypted(content)
  const out = path.join(backup.dir, 'out.tar')

  await runJoin(backup.manifestPath, { out }, quiet(passwordDeps()))

  assert.deepEqual(await fs.readFile(out), content)
})

test('an encrypted join with a wrong password writes nothing', async () => {
  const backup = await downloadedEncrypted(randomBytes(1000))
  const out = path.join(backup.dir, 'out.tar')

  await assert.rejects(
    () => runJoin(backup.manifestPath, { out }, quiet(passwordDeps({ password: 'wrong' }))),
    /either the password is wrong/,
  )

  assert.equal(await exists(out), false)
  assert.equal(await exists(`${out}.joining`), false)
})

test('an encrypted join with no terminal is refused before anything is written', async () => {
  const backup = await downloadedEncrypted(randomBytes(100))
  const out = path.join(backup.dir, 'out.tar')

  await assert.rejects(
    () => runJoin(backup.manifestPath, { out }, quiet({ ...passwordDeps(), interactive: () => false })),
    /no terminal/,
  )

  assert.equal(await exists(`${out}.joining`), false)
})

test('a chunk that decrypts to the wrong bytes is refused, even though its ciphertext matched', async () => {
  const dir = await tempDir('join-encrypted')
  const { manifest, pieces, keys, plainSha256 } = await encryptedBackup({
    content: randomBytes(1000),
    chunkSize: 400,
  })

  for (const piece of pieces) await fs.writeFile(path.join(dir, chunkFileName(manifest.id, piece.i)), piece.bytes)

  // The ciphertext sha256 in the manifest is untouched — only the sealed plaintext hash for
  // chunk 1 is wrong, so the chunk file itself passes its first check and only decrypting it
  // can catch this.
  const tampered = sealManifest(
    { ...manifest },
    keys,
    plainSha256.map((hash, i) => (i === 1 ? 'f'.repeat(64) : hash)),
  )
  const manifestPath = path.join(dir, manifestFileName(manifest.id))
  await fs.writeFile(manifestPath, serializeManifest(tampered))

  const out = path.join(dir, 'out.tar')

  await assert.rejects(
    () => runJoin(manifestPath, { out }, quiet(passwordDeps())),
    /decrypted to bytes that do not match/,
  )

  assert.equal(await exists(out), false)
  assert.equal(await exists(`${out}.joining`), false)
})

test('join unnames its temporary file when a chunk fails too', async () => {
  const backup = await downloadedBackup()
  await fs.writeFile(path.join(backup.dir, chunkFileName(backup.id, 2)), randomBytes(200))
  const out = path.join(await tempDir('join-out'), 'restored.tar')
  const seen = []

  await assert.rejects(
    runJoin(backup.manifestPath, { out }, quiet({ onTempChunk: (file) => seen.push(file) })),
    /sha256/,
  )

  assert.deepEqual(seen, [`${out}.joining`, null])
})
