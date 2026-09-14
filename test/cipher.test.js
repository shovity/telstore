import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  chunkCipher,
  decryptInPlace,
  deriveKeys,
  newIv,
  newSalt,
  openManifest,
  passwordCheck,
  sealManifest,
} from '../src/cipher.js'

import { tempDir } from './helpers.js'

const PASSWORD = 'correct horse battery'
const SALT = '00112233445566778899aabbccddeeff'
const KEYS = await deriveKeys(PASSWORD, SALT)
const HASHES = ['c'.repeat(64), 'd'.repeat(64)]

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sample() {
  return {
    v: 2,
    id: 'telstore-20260914-ab12cd',
    name: 'data.tar',
    size: 20,
    chunkSize: 16,
    createdAt: '2026-09-14T08:00:00.000Z',
    note: 'march',
    enc: { salt: SALT, hint: 'the cat' },
    chunks: [
      { i: 0, msgId: 1001, size: 16, sha256: 'a'.repeat(64), iv: '0011223344556677' },
      { i: 1, msgId: 1002, size: 4, sha256: 'b'.repeat(64), iv: '8899aabbccddeeff' },
    ],
  }
}

test('salts and ivs are fresh random hex of the right length', () => {
  assert.match(newSalt(), /^[0-9a-f]{32}$/)
  assert.match(newIv(), /^[0-9a-f]{16}$/)
  assert.notEqual(newSalt(), newSalt())
  assert.notEqual(newIv(), newIv())
})

test('the chunk key and the manifest key are different keys', () => {
  assert.equal(KEYS.chunkKey.length, 32)
  assert.equal(KEYS.manifestKey.length, 32)
  assert.notDeepEqual(KEYS.chunkKey, KEYS.manifestKey)
})

// macOS and Linux hand back different spellings of the same accented password.
test('both Unicode spellings of one password derive the same keys', async () => {
  const composed = await deriveKeys('café', SALT)
  const decomposed = await deriveKeys('café', SALT)
  assert.deepEqual(composed, decomposed)
})

test('the password check tells the right password from a wrong one', async () => {
  assert.equal(passwordCheck(await deriveKeys(PASSWORD, SALT)), passwordCheck(KEYS))
  assert.notEqual(passwordCheck(await deriveKeys('wrong', SALT)), passwordCheck(KEYS))
})

// The counter layout is iv || uint64_be(block), so Node's own CTR over the whole buffer with
// that starting block is the reference every piecewise call has to agree with.
test('encrypting piece by piece at odd offsets equals one pass over the whole chunk', () => {
  const iv = '0123456789abcdef'
  const clear = randomBytes(1000)
  const reference = createCipheriv(
    'aes-256-ctr',
    KEYS.chunkKey,
    Buffer.concat([Buffer.from(iv, 'hex'), Buffer.alloc(8)]),
  ).update(clear)

  const cipher = chunkCipher(KEYS.chunkKey, iv)
  const cuts = [0, 7, 100, 513, 1000]
  const pieces = cuts.slice(0, -1).map((at, n) => cipher.apply(clear.subarray(at, cuts[n + 1]), at))

  assert.deepEqual(Buffer.concat(pieces), reference)
})

test('applying the cipher twice gives the plaintext back, and the ciphertext is not it', () => {
  const clear = randomBytes(300)
  const cipher = chunkCipher(KEYS.chunkKey, newIv())
  const sealed = cipher.apply(clear, 0)

  assert.equal(sealed.length, clear.length)
  assert.notDeepEqual(sealed, clear)
  assert.deepEqual(cipher.apply(sealed, 0), clear)
})

test('two ivs never give the same ciphertext for the same bytes', () => {
  const clear = randomBytes(64)
  assert.notDeepEqual(
    chunkCipher(KEYS.chunkKey, '0000000000000000').apply(clear, 0),
    chunkCipher(KEYS.chunkKey, '0000000000000001').apply(clear, 0),
  )
})

test('a sealed manifest opens with the password and hands back the plaintext hashes', async () => {
  const sealed = sealManifest(sample(), KEYS, HASHES)

  assert.equal(typeof sealed.enc.sealed, 'string')
  assert.deepEqual(Object.keys(sealed.enc), ['salt', 'hint', 'sealed'])

  const opened = await openManifest(sealed, PASSWORD)
  assert.deepEqual(opened.plainSha256, HASHES)
  assert.deepEqual(opened.keys, KEYS)
})

test('a wrong password does not open it', async () => {
  assert.equal(await openManifest(sealManifest(sample(), KEYS, HASHES), 'wrong'), null)
})

// A plaintext hash in the open lets anyone confirm the backup is a copy of a file they have.
test('no plaintext hash appears anywhere in the sealed manifest', () => {
  const text = JSON.stringify(sealManifest(sample(), KEYS, HASHES))
  for (const hash of HASHES) assert.equal(text.includes(hash), false)
})

const TAMPERS = {
  name: (m) => { m.name = 'other.tar' },
  note: (m) => { m.note = 'april' },
  hint: (m) => { m.enc.hint = 'the dog' },
  size: (m) => { m.size = 21 },
  chunkSize: (m) => { m.chunkSize = 17 },
  createdAt: (m) => { m.createdAt = '2026-09-15T08:00:00.000Z' },
  id: (m) => { m.id = 'telstore-20260914-ffffff' },
  msgId: (m) => { m.chunks[0].msgId = 9999 },
  sha256: (m) => { m.chunks[1].sha256 = 'e'.repeat(64) },
  iv: (m) => { m.chunks[0].iv = 'ffffffffffffffff' },
}

for (const [field, tamper] of Object.entries(TAMPERS)) {
  test(`changing ${field} after sealing stops the manifest opening`, async () => {
    const sealed = structuredClone(sealManifest(sample(), KEYS, HASHES))
    tamper(sealed)
    assert.equal(await openManifest(sealed, PASSWORD), null)
  })
}

test('a seal that opens to something telstore never writes is refused, not trusted', async () => {
  const sealed = sealManifest(sample(), KEYS, ['c'.repeat(64)])
  await assert.rejects(() => openManifest(sealed, PASSWORD), /not what telstore writes/)
})

test('decryptInPlace turns a range back into plaintext and leaves the rest alone', async () => {
  const dir = await tempDir('cipher')
  const file = path.join(dir, 'region.bin')
  const clear = randomBytes(37)
  const cipher = chunkCipher(KEYS.chunkKey, newIv())

  await fs.writeFile(file, Buffer.concat([Buffer.from('JUNK'), cipher.apply(clear, 0), Buffer.from('TAIL')]))

  const handle = await fs.open(file, 'r+')
  let digest
  try {
    digest = await decryptInPlace(handle, 4, clear.length, cipher, { blockSize: 5 })
  } finally {
    await handle.close()
  }

  assert.equal(digest, sha(clear))
  assert.deepEqual(await fs.readFile(file), Buffer.concat([Buffer.from('JUNK'), clear, Buffer.from('TAIL')]))
})
