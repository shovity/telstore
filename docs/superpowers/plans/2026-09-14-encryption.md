# Encryption (`--encrypt`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in password encryption of a backup's contents on every upload and restore path, with an optional plain-text hint shown back at restore time.

**Architecture:** Chunk bytes are encrypted with AES-256-CTR (length-preserving, so chunk layout and every existing size/offset check stay as they are) through a `transform` hook in `uploadRange`. The manifest becomes `v: 2` for encrypted backups and carries a GCM-sealed list of plaintext hashes, authenticated over every other field. Every restore path checks the ciphertext sha256 (as today), then decrypts, then checks the plaintext sha256.

**Tech Stack:** Node 18+ ESM, `node:crypto` (scrypt, HKDF, AES-256-CTR, AES-256-GCM, HMAC), `node:test`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-09-14-encryption-design.md` — read it before starting any task.

## Global Constraints

- English only: code, comments, user-facing strings, test names, docs, commit messages.
- Style: no semicolons, single quotes, two-space indent. Pure ESM, no TypeScript.
- Exactly one runtime dependency (`teleproto`). Tests use `node:test` only. `npm test` is the gate.
- Commands take collaborators through `deps`; every new collaborator (`askNewPassword`, `askPassword`, `interactive`, `secret`, `knownPasswords`) goes through that seam.
- **Never produce wrong data silently.** No integrity check is relaxed to make a test pass.
- Before changing a file, read the design doc CLAUDE.md's table names for it (e.g. `docs/design/data-integrity.md` before `manifest.js`/`restore.js`/`join.js`, `docs/design/module-boundaries.md` before `uploader.js`, `docs/design/terminal-prompts.md` before anything that prompts, `docs/design/captions.md` before `caption.js`/`list.js`, `docs/design/settings-and-flags.md` before `cli.js`).
- Unencrypted backups must stay byte-for-byte what telstore writes today: `v: 1`, no `enc`, no `iv`.
- scrypt parameters `{ N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }`; HKDF infos `'telstore v2 chunk key'`, `'telstore v2 manifest key'`; HMAC message `'telstore v2 password check'`; AAD tag `'telstore-enc-v2'`.
- `MAX_HINT_LENGTH = 100`. `PASSWORD_ATTEMPTS = 3`.
- Salt: 16 bytes, 32 lowercase hex. Chunk `iv`: 8 bytes, 16 lowercase hex. Sealed blob: base64 of `nonce(12) | tag(16) | ciphertext`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/cipher.js` (new) | Pure crypto: key derivation, password check, CTR at any offset, manifest seal/open, decrypt a file range in place. No teleproto, no prompts. |
| `src/password.js` (new) | Everything that asks for or tries a password: `askNewPassword`, `askPassword`, `unlockManifest`. |
| `src/manifest.js` | `v: 2` build and structural parse, `isEncrypted`. |
| `src/caption.js` | `parseHint`, `MAX_HINT_LENGTH`, the `🔒`/`💡` card lines. |
| `src/commands/list.js` | `LOCK` column. |
| `src/uploader.js` | Optional `transform(bytes, offsetInRange)` hook. |
| `src/commands/upload.js` | `--encrypt` for file and batch upload, resume rules. |
| `src/commands/upload-stream.js` | `--encrypt` for `--` and `tarc`. |
| `src/commands/restore.js` | Unlock, decrypt in place, scan against plaintext hashes, batch password reuse. |
| `src/commands/restore-stream.js` | Unlock before spawn, decrypt the temp chunk before handing it over. |
| `src/commands/join.js` | Unlock, decrypt while copying. |
| `src/commands/verify.js` | `Lock` header line. |
| `src/commands/status.js` | `--encrypt` in the printed resume command. |
| `src/cli.js` | `--encrypt` option, refusal outside upload, HELP. |
| `test/helpers.js` | `PASSWORD`, `encryptedBackup`, `passwordDeps`, `sharesRun`. |
| docs | `docs/design/encryption.md` (new), `CLAUDE.md`, `data-integrity.md`, `settings-and-flags.md`, `captions.md`, README. |

---

### Task 1: `src/cipher.js`

**Files:**
- Create: `src/cipher.js`
- Test: `test/cipher.test.js`

**Interfaces:**
- Produces:
  - `newSalt(): string` (32 hex), `newIv(): string` (16 hex)
  - `deriveKeys(password: string, salt: string): Promise<{ chunkKey: Buffer, manifestKey: Buffer }>`
  - `passwordCheck(keys): string` (64 hex)
  - `chunkCipher(chunkKey: Buffer, iv: string): { apply(bytes: Buffer, offset: number): Buffer }` — encrypts and decrypts (CTR is symmetric)
  - `additionalData(manifest): Buffer`
  - `sealManifest(manifest, keys, plainSha256: string[]): manifest` — returns a copy with `enc.sealed` set
  - `openManifest(manifest, password): Promise<{ keys, plainSha256: string[] } | null>` — null on a failed tag; throws if the tag passes but the contents are malformed
  - `decryptInPlace(handle: FileHandle, offset: number, length: number, cipher, { blockSize } = {}): Promise<string>` — plaintext sha256 hex

- [ ] **Step 1: Write the failing tests**

Create `test/cipher.test.js`:

```js
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
  const decomposed = await deriveKeys('café', SALT)
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/cipher.test.js`
Expected: FAIL with `Cannot find module '.../src/cipher.js'`.

- [ ] **Step 3: Implement `src/cipher.js`**

```js
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scrypt } from 'node:crypto'
import { promisify } from 'node:util'

const derive = promisify(scrypt)

// Pinned to manifest version 2 and never read from a manifest, for the reason src/token.js
// pins its own: a manifest naming its own N would let a stranger decide how much memory this
// machine allocates, and whoever holds a manifest can try passwords offline as fast as their
// hardware allows — 64MB per attempt is what makes that expensive.
const SCRYPT = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }
const KEY_BYTES = 32
const SALT_BYTES = 16
const IV_BYTES = 8
const NONCE_BYTES = 12
const TAG_BYTES = 16
const BLOCK = 16
const SHA256 = /^[0-9a-f]{64}$/

// Large enough that a 1800MB chunk is a couple of hundred reads, and a multiple of the AES
// block so a full pass never needs the partial-block path.
const IN_PLACE_BLOCK = 8 * 1024 * 1024

export function newSalt() {
  return randomBytes(SALT_BYTES).toString('hex')
}

// Fresh for every attempt at a chunk, never derived from its index: a run that dies halfway
// through chunk 3 leaves parts of it on Telegram's servers, and a derived nonce would put the
// next run's chunk 3 — possibly different bytes, if the file changed — under the same keystream.
export function newIv() {
  return randomBytes(IV_BYTES).toString('hex')
}

// Two keys, because GCM is CTR inside: one key used for both would let a counter block of the
// manifest seal coincide with a counter block of some chunk.
export async function deriveKeys(password, salt) {
  const saltBytes = Buffer.from(salt, 'hex')
  const master = await derive(String(password).normalize('NFC'), saltBytes, KEY_BYTES, SCRYPT)

  return {
    chunkKey: Buffer.from(hkdfSync('sha256', master, saltBytes, 'telstore v2 chunk key', KEY_BYTES)),
    manifestKey: Buffer.from(hkdfSync('sha256', master, saltBytes, 'telstore v2 manifest key', KEY_BYTES)),
  }
}

// What an unfinished upload keeps on disk instead of the password: enough to refuse a resume
// under a different one, which would put two keys into one backup.
export function passwordCheck(keys) {
  return createHmac('sha256', keys.manifestKey).update('telstore v2 password check').digest('hex')
}

// CTR at any offset inside a chunk: the counter block for byte `offset` is the chunk's iv
// followed by the 64-bit block number, and the bytes before `offset` inside that block are
// discarded. A chunk is at most 1950MB, about 1.3e8 blocks, so the counter never carries into
// the iv.
export function chunkCipher(chunkKey, iv) {
  const prefix = Buffer.from(iv, 'hex')

  return {
    apply(bytes, offset) {
      const counter = Buffer.alloc(BLOCK)
      prefix.copy(counter, 0)
      counter.writeBigUInt64BE(BigInt(Math.floor(offset / BLOCK)), IV_BYTES)

      const cipher = createCipheriv('aes-256-ctr', chunkKey, counter)
      const skip = offset % BLOCK

      if (skip > 0) cipher.update(Buffer.alloc(skip))

      return Buffer.concat([cipher.update(bytes), cipher.final()])
    },
  }
}

// Built from the fields, in one fixed order, and never by serializing the parsed object again:
// an array has one serialization, while an object's depends on the key order of a file a person
// can edit. Every field is covered, the readable ones included — a hint changed by someone else
// is a line of their choosing printed by telstore.
export function additionalData(manifest) {
  return Buffer.from(
    JSON.stringify([
      'telstore-enc-v2',
      manifest.id,
      manifest.name,
      manifest.size,
      manifest.chunkSize,
      manifest.createdAt,
      manifest.note ?? null,
      manifest.enc.salt,
      manifest.enc.hint ?? null,
      manifest.chunks.map((chunk) => [chunk.i, chunk.msgId, chunk.size, chunk.sha256, chunk.iv]),
    ]),
    'utf8',
  )
}

export function sealManifest(manifest, keys, plainSha256) {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', keys.manifestKey, nonce)

  cipher.setAAD(additionalData(manifest))

  const body = Buffer.concat([cipher.update(JSON.stringify({ plainSha256 }), 'utf8'), cipher.final()])

  return {
    ...manifest,
    enc: {
      ...manifest.enc,
      sealed: Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64'),
    },
  }
}

// Null when the tag fails, which is one failure with two causes — a wrong password or an
// altered manifest — and the caller is the one that decides whether to ask again. Past the tag
// the contents are ours, so anything malformed there is a telstore that disagreed with this one
// about the format, and that throws rather than reading as a wrong password.
export async function openManifest(manifest, password) {
  const keys = await deriveKeys(password, manifest.enc.salt)
  const sealed = Buffer.from(manifest.enc.sealed, 'base64')

  if (sealed.length <= NONCE_BYTES + TAG_BYTES) return null

  const decipher = createDecipheriv('aes-256-gcm', keys.manifestKey, sealed.subarray(0, NONCE_BYTES))
  decipher.setAAD(additionalData(manifest))
  decipher.setAuthTag(sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES))

  let text
  try {
    text = Buffer.concat([
      decipher.update(sealed.subarray(NONCE_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }

  let inside = null
  try {
    inside = JSON.parse(text)
  } catch {
    // Falls through to the refusal below.
  }

  const hashes = inside?.plainSha256

  if (
    !Array.isArray(hashes) ||
    hashes.length !== manifest.chunks.length ||
    !hashes.every((hash) => typeof hash === 'string' && SHA256.test(hash))
  ) {
    throw new Error(
      `The manifest of ${manifest.id} opened, but what is sealed inside it is not what telstore ` +
        'writes. Refusing to restore from it.',
    )
  }

  return { keys, plainSha256: hashes }
}

async function readFully(handle, buffer, length, position) {
  let filled = 0

  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled)

    if (bytesRead === 0) {
      throw new Error(`Short read: needed ${length} bytes at offset ${position} but the file ended.`)
    }

    filled += bytesRead
  }
}

async function writeFully(handle, buffer, position) {
  let written = 0

  while (written < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, written, buffer.length - written, position + written)
    written += bytesWritten
  }
}

// Reads a range that holds a verified chunk's ciphertext, writes its plaintext back over it,
// and hashes the plaintext on the way. Called only after the ciphertext sha256 has matched, so
// the hash it returns is the second check, not the first.
export async function decryptInPlace(handle, offset, length, cipher, { blockSize = IN_PLACE_BLOCK } = {}) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(blockSize, Math.max(length, 1)))

  for (let at = 0; at < length; at += blockSize) {
    const size = Math.min(blockSize, length - at)

    await readFully(handle, buffer, size, offset + at)

    const clear = cipher.apply(buffer.subarray(0, size), at)

    hash.update(clear)
    await writeFully(handle, clear, offset + at)
  }

  return hash.digest('hex')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/cipher.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Run the whole suite and commit**

Run: `npm test` — expected all green.

```bash
git add src/cipher.js test/cipher.test.js
git commit -m "feat: add the cipher module encryption is built on"
```

---

### Task 2: Manifest version 2 and the encrypted test fixture

**Files:**
- Modify: `src/manifest.js` (`MANIFEST_VERSION` block, `buildManifest`, `parseManifest`)
- Modify: `test/helpers.js` (append)
- Test: `test/manifest.test.js` (append; update the unknown-version test only if its regex no longer matches)

**Interfaces:**
- Consumes: `chunkCipher`, `deriveKeys`, `newIv`, `newSalt`, `sealManifest` from Task 1.
- Produces:
  - `ENCRYPTED_MANIFEST_VERSION = 2`
  - `buildManifest({ ..., enc = null })` — `enc` is `{ salt, hint? }`; when set, `v` is 2, `enc` sits between `note` and `chunks`, and every chunk keeps its `iv`. `plainSha256` is never copied into the manifest.
  - `isEncrypted(manifest): boolean`
  - `parseManifest` accepts v1 and v2
  - `test/helpers.js`: `PASSWORD`, `encryptedBackup({ id, name, content, chunkSize, password, hint, firstMsgId })` → `Promise<{ manifest, pieces: [{ i, msgId, bytes }], keys, plainSha256 }>`, `passwordDeps({ password, hint, asked })`, `sharesRun(haystack, plain, run = 64)`

- [ ] **Step 1: Write the failing tests**

Append to `test/manifest.test.js` (add `ENCRYPTED_MANIFEST_VERSION, isEncrypted` to its existing import from `../src/manifest.js`, and `serializeManifest`/`buildManifest`/`parseManifest` if not already imported):

```js
function encryptedFields(overrides = {}) {
  return {
    id: 'telstore-20260914-ab12cd',
    name: 'data.tar',
    size: 20,
    chunkSize: 16,
    createdAt: '2026-09-14T08:00:00.000Z',
    enc: { salt: '0'.repeat(32), hint: 'the cat' },
    chunks: [
      { i: 0, msgId: 1001, size: 16, sha256: 'a'.repeat(64), iv: '0'.repeat(16), plainSha256: 'c'.repeat(64) },
      { i: 1, msgId: 1002, size: 4, sha256: 'b'.repeat(64), iv: '1'.repeat(16), plainSha256: 'd'.repeat(64) },
    ],
    ...overrides,
  }
}

function sealedLooking(manifest) {
  return { ...manifest, enc: { ...manifest.enc, sealed: 'AAAA' } }
}

test('an encrypted manifest is version 2 and keeps each chunk iv but never its plaintext hash', () => {
  const manifest = buildManifest(encryptedFields())

  assert.equal(manifest.v, ENCRYPTED_MANIFEST_VERSION)
  assert.deepEqual(Object.keys(manifest), ['v', 'id', 'name', 'size', 'chunkSize', 'createdAt', 'enc', 'chunks'])
  assert.deepEqual(manifest.chunks.map((chunk) => chunk.iv), ['0'.repeat(16), '1'.repeat(16)])
  assert.equal(JSON.stringify(manifest).includes('plainSha256'), false)
  assert.equal(isEncrypted(manifest), true)
})

test('a plain manifest is still version 1 with no enc and no iv', () => {
  const { enc, ...fields } = encryptedFields()
  const manifest = buildManifest(fields)

  assert.equal(manifest.v, 1)
  assert.equal('enc' in manifest, false)
  assert.equal(manifest.chunks.some((chunk) => 'iv' in chunk), false)
  assert.equal(isEncrypted(manifest), false)
})

test('parseManifest reads a well-formed version 2 manifest without any password', () => {
  const parsed = parseManifest(serializeManifest(sealedLooking(buildManifest(encryptedFields()))))
  assert.equal(parsed.v, 2)
  assert.equal(parsed.enc.hint, 'the cat')
})

// An older telstore reading this as version 1 would restore the ciphertext and call it the file.
test('a version 1 manifest carrying encryption fields is refused', () => {
  const manifest = { ...sealedLooking(buildManifest(encryptedFields())), v: 1 }
  assert.throws(() => parseManifest(JSON.stringify(manifest)), /version 1, which is never encrypted/)
})

test('a version 3 manifest names the versions this telstore understands', () => {
  const manifest = { ...sealedLooking(buildManifest(encryptedFields())), v: 3 }
  assert.throws(() => parseManifest(JSON.stringify(manifest)), /understands versions 1 and 2/)
})

const BROKEN_V2 = {
  'no enc at all': (m) => { delete m.enc },
  'a salt that is not 32 hex characters': (m) => { m.enc.salt = 'abc' },
  'a hint that is not text': (m) => { m.enc.hint = 42 },
  'no sealed part': (m) => { delete m.enc.sealed },
  'a chunk without an iv': (m) => { delete m.chunks[1].iv },
  'an iv that is not 16 hex characters': (m) => { m.chunks[0].iv = 'xyz' },
}

for (const [what, breakIt] of Object.entries(BROKEN_V2)) {
  test(`a version 2 manifest with ${what} is refused`, () => {
    const manifest = structuredClone(sealedLooking(buildManifest(encryptedFields())))
    breakIt(manifest)
    assert.throws(() => parseManifest(JSON.stringify(manifest)), /Manifest/)
  })
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/manifest.test.js`
Expected: FAIL — `ENCRYPTED_MANIFEST_VERSION` / `isEncrypted` are not exported.

- [ ] **Step 3: Implement in `src/manifest.js`**

Replace `export const MANIFEST_VERSION = 1` with:

```js
export const MANIFEST_VERSION = 1

// An encrypted backup's manifest, and only that. The bump is what stops an older telstore, which
// checks `v` and nothing else it does not know: handed a version 1 manifest with an extra `enc`
// in it, it would download the ciphertext, match every sha256 (they are the ciphertext's), match
// the length (CTR keeps it), rename, and print Done over a file of random bytes.
export const ENCRYPTED_MANIFEST_VERSION = 2

const SALT_HEX = /^[0-9a-f]{32}$/
const IV_HEX = /^[0-9a-f]{16}$/

export function isEncrypted(manifest) {
  return manifest?.v === ENCRYPTED_MANIFEST_VERSION
}
```

Replace `buildManifest` with:

```js
export function buildManifest({
  id,
  name,
  size,
  chunkSize,
  chunks,
  createdAt = new Date().toISOString(),
  note = null,
  enc = null,
}) {
  return {
    v: enc ? ENCRYPTED_MANIFEST_VERSION : MANIFEST_VERSION,
    id,
    name,
    size,
    chunkSize,
    createdAt,
    // Absent rather than null when there is none: a manifest without a note has to be the
    // same file telstore wrote before the flag existed, down to the bytes.
    ...(note ? { note } : {}),
    // The same rule for encryption: a plain backup's manifest is today's manifest exactly.
    ...(enc ? { enc } : {}),
    // Picked field by field, which is also what keeps a chunk's plaintext hash out: it travels
    // in the state record and in the seal, never in the open.
    chunks: [...chunks]
      .sort((a, b) => a.i - b.i)
      .map(({ i, msgId, size: chunkBytes, sha256, iv }) => ({
        i,
        msgId,
        size: chunkBytes,
        sha256,
        ...(enc ? { iv } : {}),
      })),
  }
}
```

In `parseManifest`, replace the version check with:

```js
  if (manifest.v !== MANIFEST_VERSION && manifest.v !== ENCRYPTED_MANIFEST_VERSION) {
    throw new Error(
      `Manifest uses version ${manifest.v}, this build of telstore only understands versions ` +
        `${MANIFEST_VERSION} and ${ENCRYPTED_MANIFEST_VERSION}.`,
    )
  }

  // Version 1 is never encrypted. A manifest claiming both would be restored as plain bytes by
  // every telstore that reads version 1, which is the silent wrong file the bump exists to stop.
  if (manifest.v === MANIFEST_VERSION && manifest.enc !== undefined) {
    throw new Error(
      'Manifest says version 1, which is never encrypted, and carries encryption fields anyway. ' +
        'Restoring it as version 1 would hand over encrypted bytes as the file, so telstore is ' +
        'not reading it.',
    )
  }
```

and, immediately after the first `manifest.chunks.forEach(...)` loop (the one that checks each entry is an object with a whole-number size and a contiguous `i`), add:

```js
  if (manifest.v === ENCRYPTED_MANIFEST_VERSION) checkEncryption(manifest)
```

and add this function above `parseManifest`:

```js
// Structure only. Whether the seal opens is a question for the password, which verify never
// has and never needs — so everything here is answerable from the file alone.
function checkEncryption(manifest) {
  const { enc } = manifest

  if (typeof enc !== 'object' || enc === null || Array.isArray(enc)) {
    throw new Error('Manifest is version 2, which is encrypted, but carries no encryption details.')
  }

  if (typeof enc.salt !== 'string' || !SALT_HEX.test(enc.salt)) {
    throw new Error(`Manifest records ${JSON.stringify(enc.salt)} as its salt, which is not 32 hex characters.`)
  }

  if (enc.hint !== undefined && typeof enc.hint !== 'string') {
    throw new Error(`Manifest records a hint of ${JSON.stringify(enc.hint)}, which is not text.`)
  }

  if (typeof enc.sealed !== 'string' || enc.sealed === '') {
    throw new Error('Manifest is encrypted but carries no sealed part, so nothing can check what it decrypts to.')
  }

  manifest.chunks.forEach((chunk, index) => {
    if (typeof chunk.iv !== 'string' || !IV_HEX.test(chunk.iv)) {
      throw new Error(
        `Manifest records ${JSON.stringify(chunk.iv)} as the iv of chunk ${index + 1}, which is not 16 hex characters.`,
      )
    }
  })
}
```

- [ ] **Step 4: Add the encrypted fixture to `test/helpers.js`**

Add to the imports at the top:

```js
import { createHash } from 'node:crypto'

import { chunkCipher, deriveKeys, newIv, newSalt, sealManifest } from '../src/cipher.js'
import { buildManifest } from '../src/manifest.js'
```

Append:

```js
export const PASSWORD = 'correct horse battery'

// Built with the real cipher, never a stand-in: a fake that "encrypted" by copying is exactly
// the fake that would let an upload with no transform wired in pass every round trip.
export async function encryptedBackup({
  id = 'telstore-20260914-ab12cd',
  name = 'data.tar',
  content,
  chunkSize,
  password = PASSWORD,
  hint = null,
  firstMsgId = 1000,
}) {
  const salt = newSalt()
  const keys = await deriveKeys(password, salt)
  const pieces = []
  const chunks = []
  const plainSha256 = []

  for (let offset = 0, i = 0; offset < content.length; offset += chunkSize, i += 1) {
    const clear = content.subarray(offset, Math.min(offset + chunkSize, content.length))
    const iv = newIv()
    const bytes = chunkCipher(keys.chunkKey, iv).apply(clear, 0)
    const msgId = firstMsgId + i

    pieces.push({ i, msgId, bytes })
    chunks.push({ i, msgId, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), iv })
    plainSha256.push(createHash('sha256').update(clear).digest('hex'))
  }

  const built = buildManifest({
    id,
    name,
    size: content.length,
    chunkSize,
    chunks,
    enc: { salt, ...(hint ? { hint } : {}) },
  })

  return { manifest: sealManifest(built, keys, plainSha256), pieces, keys, plainSha256 }
}

// The password seam every encrypted test drives. `asked` records what was asked for, so a test
// can say "one password for the whole batch" about the prompts rather than about a count.
export function passwordDeps({ password = PASSWORD, hint = null, asked = [] } = {}) {
  return {
    interactive: () => true,
    askNewPassword: async () => {
      asked.push('new')
      return { password, hint }
    },
    askPassword: async (question) => {
      asked.push(question)
      return password
    },
  }
}

// Whether any `run`-byte stretch of the plaintext appears in what was sent. Only meaningful for
// plaintext with no repetition in it — use random bytes.
export function sharesRun(haystack, plain, run = 64) {
  for (let at = 0; at + run <= plain.length; at += 1) {
    if (haystack.includes(plain.subarray(at, at + run))) return true
  }

  return false
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/manifest.test.js` — expected PASS. If the existing `parseManifest rejects an unknown version` test fails, its regex (`/version/`) still matches the new wording; do not change the wording to fit any stricter regex without reading why it exists.

Run: `npm test` — expected all green.

- [ ] **Step 6: Commit**

```bash
git add src/manifest.js test/manifest.test.js test/helpers.js
git commit -m "feat: manifest version 2 for encrypted backups"
```

---

### Task 3: Hint parsing, card lines and the `LOCK` column

**Files:**
- Modify: `src/caption.js`
- Modify: `src/commands/list.js` (`COLUMNS`, `toRow`, the column filter around line 155)
- Test: `test/caption.test.js`, `test/list.test.js` (append)

**Interfaces:**
- Produces:
  - `MAX_HINT_LENGTH = 100`
  - `parseHint(raw, password = null): string | null` — folds to one line; empty → null; too long or containing the password → throws
  - `manifestCaption({ ..., encrypted = false, hint = null })`
  - `parseManifestCaption(text)` returns `{ ..., encrypted: boolean, hint: string | null }`

- [ ] **Step 1: Write the failing tests**

Append to `test/caption.test.js` (add `MAX_HINT_LENGTH, parseHint` to its import from `../src/caption.js`, plus `manifestCaption, parseManifestCaption` if not imported):

```js
test('an encrypted card says so and carries the hint, and parses back', () => {
  const caption = manifestCaption({
    id: 'telstore-20260914-ab12cd',
    name: 'data.tar',
    size: 1000,
    chunks: 1,
    createdAt: '2026-09-14T08:00:00.000Z',
    encrypted: true,
    hint: 'the cat',
  })

  assert.match(caption, /\n🔒 encrypted\n💡 the cat\n/)

  const card = parseManifestCaption(caption)
  assert.equal(card.encrypted, true)
  assert.equal(card.hint, 'the cat')
})

test('a plain card is unchanged and parses as not encrypted', () => {
  const caption = manifestCaption({
    id: 'telstore-20260914-ab12cd',
    name: 'data.tar',
    size: 1000,
    chunks: 1,
    createdAt: '2026-09-14T08:00:00.000Z',
  })

  assert.equal(caption.includes('🔒'), false)
  assert.equal(parseManifestCaption(caption).encrypted, false)
  assert.equal(parseManifestCaption(caption).hint, null)
})

// Telegram takes 1024 characters in a caption. This is the worst card telstore can write.
test('the longest card with a lock and the longest hint still fits a caption', () => {
  const caption = manifestCaption({
    id: 'telstore-20260914-abcdef',
    name: 'x'.repeat(255),
    size: 19.9e12,
    chunks: 10000,
    createdAt: '2026-09-14T08:00:00.000Z',
    note: 'n'.repeat(500),
    encrypted: true,
    hint: 'h'.repeat(MAX_HINT_LENGTH),
  })

  assert.ok(caption.length <= 1024, `${caption.length} characters`)
})

test('a hint is folded onto one line, and an empty one is no hint', () => {
  assert.equal(parseHint('  the\n cat  '), 'the cat')
  assert.equal(parseHint('   '), null)
  assert.equal(parseHint(undefined), null)
})

test('a hint longer than the card has room for is refused, not cut', () => {
  assert.throws(() => parseHint('h'.repeat(MAX_HINT_LENGTH + 1)), /room for 100/)
})

test('a hint that contains the password is refused', () => {
  assert.throws(() => parseHint('it is Hunter2 obviously', 'hunter2'), /contains the password/)
  assert.equal(parseHint('my cat', 'hunter2'), 'my cat')
})
```

Append to `test/list.test.js`:

```js
test('a LOCK column appears when a backup is encrypted, carrying its hint', async () => {
  const configDir = await workspace()
  const out = collect()
  const createdAt = '2026-09-14T08:00:00.000Z'
  const locked = {
    id: 2001,
    fileName: 'telstore-20260914-ab12cd.manifest.json',
    caption: manifestCaption({
      id: 'telstore-20260914-ab12cd',
      name: 'secret.tar',
      size: 1000,
      chunks: 1,
      createdAt,
      encrypted: true,
      hint: 'the cat',
    }),
    date: Math.floor(Date.parse(createdAt) / 1000),
  }

  await runList({}, deps(configDir, [locked, DATA_TAR], out))

  assert.match(out.text(), /LOCK/)
  assert.match(out.text(), /🔒 the cat/)
})

test('no LOCK column when nothing is encrypted', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({}, deps(configDir, [DATA_TAR], out))

  assert.doesNotMatch(out.text(), /LOCK/)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/caption.test.js test/list.test.js`
Expected: FAIL — `parseHint`/`MAX_HINT_LENGTH` not exported; no `🔒` line; no `LOCK` column.

- [ ] **Step 3: Implement in `src/caption.js`**

After `parseNote`, add:

```js
// What the card has left once every other line has had its share. Measured 2026-09-14: the
// worst card telstore writes without encryption — a 255-character name, a 500-character note,
// 10000 chunks — is 899 of Telegram's 1024 characters, and the lock and hint lines leave 108.
export const MAX_HINT_LENGTH = 100

const LOCK_LINE = '🔒 encrypted'

// Written at the password prompt and shown in the open: on the card, in `list`, and above the
// password prompt at restore time. So a hint holding the password is a password in the chat.
export function parseHint(raw, password = null) {
  if (raw === undefined || raw === null) return null

  const hint = oneLine(raw)

  if (hint === '') return null

  if (hint.length > MAX_HINT_LENGTH) {
    throw new Error(
      `The hint is ${hint.length} characters, and the card in the chat has room for ` +
        `${MAX_HINT_LENGTH}. Shorten it: telstore will not cut it short by itself.`,
    )
  }

  if (password && hint.toLowerCase().includes(String(password).toLowerCase())) {
    throw new Error(
      'The hint contains the password itself, and the hint is shown in the chat as plain ' +
        'text. Write something only you would connect with it.',
    )
  }

  return hint
}
```

Change `manifestCaption`'s signature to `({ id, name, size, chunks, createdAt, note = null, encrypted = false, hint = null })` and, right after the note line in its array, add:

```js
    // Below the note and above the restore line: the lock is a fact about the backup a person
    // needs before they try to restore it, and the hint is what they will need at the prompt.
    ...(encrypted ? [LOCK_LINE] : []),
    ...(encrypted && hint ? [`💡 ${oneLine(hint)}`] : []),
```

In `parseManifestCaption`, before the `if (!name || ...)` check add:

```js
  // Both optional, like the note: every card telstore wrote before encryption existed is a
  // complete card with neither.
  const encrypted = lines.includes(LOCK_LINE)
  const hint = marker(lines, '💡')
```

and return `{ id, name, size: match[1], chunks: Number(match[2]), createdAt, note, encrypted, hint }`.

- [ ] **Step 4: Implement in `src/commands/list.js`**

Add to `COLUMNS` after the `NOTE` entry: `{ header: 'LOCK', key: 'lock' },`.

In `toRow`, add `lock: UNKNOWN,` to the unreadable-card object, and in the card branch:

```js
    // The hint is here because this is where someone who forgot a password looks first.
    lock: card.encrypted ? (card.hint ? `🔒 ${shorten(card.hint)}` : '🔒') : UNKNOWN,
```

Replace the column filter (currently `COLUMNS.filter((column) => column.key !== 'note' || rows.some((row) => row.note !== UNKNOWN))`) with:

```js
  // Most people never write a note or encrypt, and a column of dashes tells them nothing they
  // did not already know.
  const columns = COLUMNS.filter(
    (column) =>
      (column.key !== 'note' || rows.some((row) => row.note !== UNKNOWN)) &&
      (column.key !== 'lock' || rows.some((row) => row.lock !== UNKNOWN)),
  )
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/caption.test.js test/list.test.js` — PASS. Then `npm test` — all green.

- [ ] **Step 6: Commit**

```bash
git add src/caption.js src/commands/list.js test/caption.test.js test/list.test.js
git commit -m "feat: lock and hint lines on the manifest card, LOCK column in list"
```

---

### Task 4: `src/password.js`

**Files:**
- Create: `src/password.js`
- Test: `test/password.test.js`

**Interfaces:**
- Consumes: `parseHint` (Task 3), `openManifest` (Task 1), `createPrompts`, `readSecret` from `src/prompt.js`.
- Produces:
  - `PASSWORD_ATTEMPTS = 3`
  - `askNewPassword({ input, output } = {}): Promise<{ password: string, hint: string | null }>`
  - `askPassword(question: string): Promise<string>`
  - `unlockManifest(manifest, { askPassword, interactive, known = [], say = () => {} }): Promise<{ keys, plainSha256, password }>` — tries `known` first silently; pushes a newly typed password that worked onto `known`

- [ ] **Step 1: Write the failing tests**

Create `test/password.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'

import { askNewPassword, unlockManifest } from '../src/password.js'

import { PASSWORD, encryptedBackup } from './helpers.js'

// Answers each question only once it has been asked. A line that reaches readline before its
// question exists is dropped, exactly as a real terminal drops it (docs/design/terminal-prompts.md),
// so writing every answer up front would test a fake that behaves better than the real thing.
function scriptedTerminal(answers) {
  const input = new PassThrough()
  input.isTTY = true
  input.setRawMode = () => input

  const queue = [...answers]
  const written = []
  const output = new PassThrough()

  output.write = (chunk) => {
    const text = String(chunk)
    written.push(text)

    if (/(Password: |Password again: |Hint .*: )$/.test(text) && queue.length > 0) {
      const next = queue.shift()
      setImmediate(() => input.write(`${next}\n`))
    }

    return true
  }

  return { input, output, text: () => written.join('') }
}

test('a new password is asked twice and a hint once', async () => {
  const term = scriptedTerminal(['s3cret pass', 's3cret pass', 'the cat'])
  const chosen = await askNewPassword({ input: term.input, output: term.output })

  assert.deepEqual(chosen, { password: 's3cret pass', hint: 'the cat' })
  assert.doesNotMatch(term.text(), /s3cret/)
})

test('an empty hint is no hint', async () => {
  const term = scriptedTerminal(['s3cret pass', 's3cret pass', ''])
  const chosen = await askNewPassword({ input: term.input, output: term.output })
  assert.equal(chosen.hint, null)
})

test('two different passwords are refused', async () => {
  const term = scriptedTerminal(['one', 'two'])
  await assert.rejects(() => askNewPassword({ input: term.input, output: term.output }), /different/)
})

test('an empty password is refused', async () => {
  const term = scriptedTerminal([''])
  await assert.rejects(() => askNewPassword({ input: term.input, output: term.output }), /empty/)
})

test('a hint that gives the password away is refused', async () => {
  const term = scriptedTerminal(['hunter2', 'hunter2', 'it is hunter2'])
  await assert.rejects(() => askNewPassword({ input: term.input, output: term.output }), /contains the password/)
})

test('no terminal means no password, and nothing is written', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const written = []
  const output = new PassThrough()
  output.write = (chunk) => written.push(String(chunk))

  await assert.rejects(() => askNewPassword({ input, output }), /--encrypt needs a terminal/)
  assert.equal(written.join(''), '')
})

async function fixture(hint = 'the cat') {
  return await encryptedBackup({ content: randomBytes(40), chunkSize: 16, hint })
}

test('unlock shows the hint and opens with the right password', async () => {
  const { manifest, plainSha256 } = await fixture()
  const said = []
  const opened = await unlockManifest(manifest, {
    askPassword: async () => PASSWORD,
    interactive: () => true,
    say: (line) => said.push(line),
  })

  assert.deepEqual(opened.plainSha256, plainSha256)
  assert.equal(opened.password, PASSWORD)
  assert.ok(said.includes('Hint   the cat'))
})

test('a wrong password is asked again, and three wrong ones stop', async () => {
  const { manifest } = await fixture()
  let asked = 0

  await assert.rejects(
    () =>
      unlockManifest(manifest, {
        askPassword: async () => {
          asked += 1
          return 'wrong'
        },
        interactive: () => true,
      }),
    /either the password is wrong or the manifest was altered/,
  )
  assert.equal(asked, 3)
})

test('a wrong password then the right one opens it', async () => {
  const { manifest } = await fixture()
  const answers = ['wrong', PASSWORD]

  const opened = await unlockManifest(manifest, {
    askPassword: async () => answers.shift(),
    interactive: () => true,
  })

  assert.equal(opened.password, PASSWORD)
})

test('a password that already opened another backup is tried first, without asking', async () => {
  const { manifest } = await fixture()

  const opened = await unlockManifest(manifest, {
    askPassword: async () => {
      throw new Error('should not have asked')
    },
    interactive: () => false,
    known: ['other', PASSWORD],
  })

  assert.equal(opened.password, PASSWORD)
})

test('a password typed and accepted joins the known ones for the next backup', async () => {
  const { manifest } = await fixture()
  const known = []

  await unlockManifest(manifest, { askPassword: async () => PASSWORD, interactive: () => true, known })

  assert.deepEqual(known, [PASSWORD])
})

test('no terminal is refused by name before anything is asked', async () => {
  const { manifest } = await fixture()

  await assert.rejects(
    () =>
      unlockManifest(manifest, {
        askPassword: async () => {
          throw new Error('should not have asked')
        },
        interactive: () => false,
      }),
    new RegExp(`${manifest.id} is encrypted, and there is no terminal`),
  )
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/password.test.js`
Expected: FAIL with `Cannot find module '.../src/password.js'`.

- [ ] **Step 3: Implement `src/password.js`**

```js
import { stderr, stdin } from 'node:process'

import { parseHint } from './caption.js'
import { openManifest } from './cipher.js'
import { createPrompts, readSecret } from './prompt.js'

export const PASSWORD_ATTEMPTS = 3

// A password that came from an environment variable, a flag or a file came from somewhere that
// kept a copy of it, which is the rule src/token.js keeps for a passphrase. Unattended encrypted
// backups stay on the `--` pipeline with a key-based tool.
const NO_TERMINAL_UPLOAD =
  '--encrypt needs a terminal to type the password in, and there is none here. Run the upload ' +
  'where you can type it; telstore does not read a password from anywhere else.'

// One readline for the whole exchange, as docs/design/terminal-prompts.md requires: two over one
// stdin do not take turns, and the second question would read nothing. On stderr, so a stdout
// someone redirected still carries only what telstore reports.
export async function askNewPassword({ input = stdin, output = stderr } = {}) {
  if (!input.isTTY) throw new Error(NO_TERMINAL_UPLOAD)

  const prompts = createPrompts({ input, output })

  try {
    const password = await prompts.askSecret('Password: ')

    if (password === '') {
      throw new Error('The password is empty. An encrypted backup needs one — run again and type it.')
    }

    const again = await prompts.askSecret('Password again: ')

    if (again !== password) {
      throw new Error(
        'The two passwords are different, so telstore does not know which one you meant. ' +
          'Nothing was sent — run again.',
      )
    }

    const hint = parseHint(await prompts.ask('Hint (optional, shown in the chat as plain text): '), password)

    return { password, hint }
  } finally {
    prompts.close()
  }
}

export function askPassword(question) {
  return readSecret(question)
}

// Opens an encrypted manifest or says why it cannot. Passwords this run has already seen work
// are tried first and silently, so a batch of backups under one password asks once. A failed
// tag cannot tell a wrong password from an altered manifest, so the last refusal names both,
// likelier first, as src/token.js does for a token.
export async function unlockManifest(
  manifest,
  { askPassword: ask, interactive = () => Boolean(stdin.isTTY), known = [], say = () => {} },
) {
  for (const password of known) {
    const opened = await openManifest(manifest, password)
    if (opened) return { ...opened, password }
  }

  if (!interactive()) {
    throw new Error(
      `${manifest.id} is encrypted, and there is no terminal here to type its password in. ` +
        'Run this where you can type it; telstore does not read a password from anywhere else.',
    )
  }

  say(`Backup ${manifest.id} is encrypted.`)
  if (manifest.enc.hint) say(`Hint   ${manifest.enc.hint}`)

  for (let attempt = 1; attempt <= PASSWORD_ATTEMPTS; attempt += 1) {
    const password = await ask('Password: ')
    const opened = password === '' ? null : await openManifest(manifest, password)

    if (opened) {
      known.push(password)
      return { ...opened, password }
    }

    if (attempt < PASSWORD_ATTEMPTS) say('That password does not open it. Try again.')
  }

  throw new Error(
    `Could not open ${manifest.id} after ${PASSWORD_ATTEMPTS} attempts: either the password is ` +
      'wrong or the manifest was altered. Encryption cannot tell those two apart, so telstore ' +
      'will not guess — check the password first.',
  )
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/password.test.js` — PASS. If a `scriptedTerminal` test hangs, the fixture's pacing is wrong (a question's text was written in a shape the regex misses); fix the fixture, never the prompt code. Then `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/password.js test/password.test.js
git commit -m "feat: password prompts and manifest unlock"
```

---

### Task 5: `transform` hook in `uploadRange`

**Files:**
- Modify: `src/uploader.js:37-47` (options), `:97` (the read)
- Test: `test/uploader.test.js` (append)

**Interfaces:**
- Produces: `uploadRange(client, fd, { ..., transform = (bytes) => bytes })`. Called once per part, in part order, with `(bytes, offsetInRange)`; what it returns is what is hashed, sent and retried.

- [ ] **Step 1: Write the failing test**

Append to `test/uploader.test.js` (it already imports `createHash`, `randomBytes`, `fs`, `path`, `uploadRange`, `tempDir` and defines `fakeClient` with a `requests` array):

```js
// The hook encryption rides on. A transform that is never called would still pass every round
// trip, so this asserts what was sent, not what came back.
test('a transform sees each part in order, and what it returns is what is sent and hashed', async () => {
  const dir = await tempDir('uploader-transform')
  const file = path.join(dir, 'source.bin')
  const content = randomBytes(1000)
  await fs.writeFile(file, content)

  const client = fakeClient()
  const seen = []
  const flip = (bytes) => Buffer.from(bytes.map((byte) => byte ^ 0x5a))
  const handle = await fs.open(file, 'r')

  let result
  try {
    result = await uploadRange(client, handle.fd, {
      offset: 100,
      length: 700,
      fileName: 'x.part0001',
      partSize: 256,
      concurrency: 2,
      transform: (bytes, at) => {
        seen.push({ at, bytes: Buffer.from(bytes) })
        return flip(bytes)
      },
    })
  } finally {
    await handle.close()
  }

  assert.deepEqual(seen.map((part) => part.at), [0, 256, 512])
  assert.deepEqual(Buffer.concat(seen.map((part) => part.bytes)), content.subarray(100, 800))

  const expected = flip(content.subarray(100, 800))
  const sent = Buffer.concat(
    [...client.requests]
      .sort((a, b) => a.filePart - b.filePart)
      .map((request) => Buffer.from(request.bytes)),
  )

  assert.deepEqual(sent, expected)
  assert.equal(result.sha256, createHash('sha256').update(expected).digest('hex'))
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/uploader.test.js`
Expected: the new test FAILS (`seen` is empty; the plaintext was sent).

- [ ] **Step 3: Implement**

In the options destructure of `uploadRange`, add after `stallMs = DEFAULT_STALL_MS,`:

```js
    // Applied to each part as it is read, in order, before it is hashed or sent — so the sha256
    // this returns is of the bytes Telegram holds, and a retry resends the same transformed
    // buffer rather than transforming again. It is what encryption rides on, and this file knows
    // nothing else about it.
    transform = (bytes) => bytes,
```

Replace `const bytes = await readExactly(fd, partLength, offset + partOffset)` with:

```js
        const bytes = transform(await readExactly(fd, partLength, offset + partOffset), partOffset)
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/uploader.test.js` — PASS. `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/uploader.js test/uploader.test.js
git commit -m "feat: uploadRange takes a per-part transform"
```

---

### Task 6: `--encrypt` on file and batch upload, and in `status`

**Files:**
- Modify: `src/commands/upload.js` (imports, `runUpload`, `runUploads`)
- Modify: `src/commands/status.js` (`resumeCommand`)
- Test: `test/upload.test.js`, `test/uploads.test.js`, `test/status.test.js` (append)

**Interfaces:**
- Consumes: Task 1 (`chunkCipher`, `deriveKeys`, `newIv`, `newSalt`, `passwordCheck`, `sealManifest`), Task 2 (`buildManifest({ enc })`), Task 3 (`manifestCaption({ encrypted, hint })`), Task 4 (`askNewPassword`, `askPassword`), Task 5 (`transform`).
- Produces:
  - `runUpload` deps: `askNewPassword`, `askPassword`, `secret` (`{ password, hint }` handed in by a batch)
  - State record of an encrypted upload: `enc: { salt, check, hint? }`; each `done` entry `{ msgId, size, sha256, iv, plainSha256 }`
  - `runUploads` deps: `askNewPassword`

- [ ] **Step 1: Write the failing tests**

Append to `test/upload.test.js`. Add to its imports: `import { chunkCipher, openManifest } from '../src/cipher.js'` and extend the helpers import to `import { PASSWORD, fakeClient, passwordDeps, sharesRun, tempDir, uploadDeps } from './helpers.js'`.

```js
function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function encryptedRun(client, ws, extra = {}) {
  return { ...deps(client), ...passwordDeps(), configDir: ws.configDir, partSize: 128, silent: true, ...extra }
}

// The test the whole feature needs most: without a transform wired in, every round trip passes
// and plaintext goes up. So this looks at what the chat received.
test('--encrypt sends ciphertext, and the manifest opens with the password', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  const result = await runUpload(
    ws.filePath,
    { chat: '@store', 'chunk-size': '400', encrypt: true },
    encryptedRun(client, ws, passwordDeps({ hint: 'the cat' })),
  )

  const chunks = client.messages.filter((m) => !m.fileName.endsWith('.manifest.json'))
  const sent = Buffer.concat(chunks.map((m) => m.bytes))

  assert.equal(result.chunks, 3)
  assert.equal(sent.length, ws.content.length)
  assert.equal(sharesRun(sent, ws.content), false)

  const manifest = parseManifest(client.messages.at(-1).bytes)
  assert.equal(manifest.v, 2)
  assert.equal(manifest.enc.hint, 'the cat')

  const opened = await openManifest(manifest, PASSWORD)
  assert.ok(opened)
  assert.deepEqual(
    opened.plainSha256,
    [0, 400, 800].map((at) => sha256Of(ws.content.subarray(at, at + 400))),
  )

  const clear = Buffer.concat(
    manifest.chunks.map((chunk, i) => chunkCipher(opened.keys.chunkKey, chunk.iv).apply(chunks[i].bytes, 0)),
  )
  assert.deepEqual(clear, ws.content)
  assert.match(client.messages.at(-1).caption, /🔒 encrypted\n💡 the cat/)
})

test('without --encrypt nobody is asked for a password and the manifest stays version 1', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()
  const refuse = async () => {
    throw new Error('should not have asked')
  }

  await runUpload(
    ws.filePath,
    { chat: '@store', 'chunk-size': '400' },
    { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true, askNewPassword: refuse, askPassword: refuse },
  )

  assert.equal(parseManifest(client.messages.at(-1).bytes).v, 1)
})

test('the record of an unfinished encrypted upload holds a salt and a check, never the password', async () => {
  const ws = await tempWorkspace(1000)
  const stat = await fs.stat(ws.filePath)

  await assert.rejects(() =>
    runUpload(
      ws.filePath,
      { chat: '@store', 'chunk-size': '400', encrypt: true },
      encryptedRun(fakeClient({ failOnChunk: 1 }), ws),
    ),
  )

  const file = stateFile(stateKey(ws.filePath, stat.size, stat.mtimeMs), ws.configDir)
  const text = await fs.readFile(file, 'utf8')
  const state = JSON.parse(text)

  assert.match(state.enc.salt, /^[0-9a-f]{32}$/)
  assert.match(state.enc.check, /^[0-9a-f]{64}$/)
  assert.match(state.done['0'].iv, /^[0-9a-f]{16}$/)
  assert.match(state.done['0'].plainSha256, /^[0-9a-f]{64}$/)
  assert.equal(text.includes(PASSWORD), false)
})

test('a resumed encrypted upload asks for the password once and finishes a backup that decrypts', async () => {
  const ws = await tempWorkspace(1000)
  const first = fakeClient({ failOnChunk: 1 })

  await assert.rejects(() =>
    runUpload(ws.filePath, { chat: '@store', 'chunk-size': '400', encrypt: true }, encryptedRun(first, ws)),
  )

  const second = fakeClient()
  const asked = []

  await runUpload(
    ws.filePath,
    { chat: '@store', 'chunk-size': '400', encrypt: true },
    encryptedRun(second, ws, passwordDeps({ asked })),
  )

  assert.equal(asked.length, 1)
  assert.match(asked[0], /^Password for telstore-/)

  const manifest = parseManifest(second.messages.at(-1).bytes)
  const opened = await openManifest(manifest, PASSWORD)
  const all = [...first.messages, ...second.messages]
  const clear = Buffer.concat(
    manifest.chunks.map((chunk) =>
      chunkCipher(opened.keys.chunkKey, chunk.iv).apply(all.find((m) => m.id === chunk.msgId).bytes, 0),
    ),
  )

  assert.deepEqual(clear, ws.content)
})

test('a resumed encrypted upload refuses a different password and keeps its record', async () => {
  const ws = await tempWorkspace(1000)
  const stat = await fs.stat(ws.filePath)

  await assert.rejects(() =>
    runUpload(ws.filePath, { chat: '@store', 'chunk-size': '400', encrypt: true }, encryptedRun(fakeClient({ failOnChunk: 1 }), ws)),
  )

  await assert.rejects(
    () =>
      runUpload(
        ws.filePath,
        { chat: '@store', 'chunk-size': '400', encrypt: true },
        encryptedRun(fakeClient(), ws, passwordDeps({ password: 'not it' })),
      ),
    /not the password backup telstore-\d{8}-[0-9a-f]{6} was started with/,
  )

  assert.ok(await loadState(stateKey(ws.filePath, stat.size, stat.mtimeMs), ws.configDir))
})

test('an unfinished encrypted upload is refused without --encrypt', async () => {
  const ws = await tempWorkspace(1000)

  await assert.rejects(() =>
    runUpload(ws.filePath, { chat: '@store', 'chunk-size': '400', encrypt: true }, encryptedRun(fakeClient({ failOnChunk: 1 }), ws)),
  )

  await assert.rejects(
    () => runUpload(ws.filePath, { chat: '@store', 'chunk-size': '400' }, encryptedRun(fakeClient(), ws)),
    /is encrypted, and this run has no --encrypt/,
  )
})

test('an unfinished plain upload is refused with --encrypt', async () => {
  const ws = await tempWorkspace(1000)

  await assert.rejects(() =>
    runUpload(ws.filePath, { chat: '@store', 'chunk-size': '400' }, encryptedRun(fakeClient({ failOnChunk: 1 }), ws)),
  )

  await assert.rejects(
    () => runUpload(ws.filePath, { chat: '@store', 'chunk-size': '400', encrypt: true }, encryptedRun(fakeClient(), ws)),
    /is not encrypted, and this run asks for --encrypt/,
  )
})

test('a password that cannot be had stops the run before a record or a connection', async () => {
  const ws = await tempWorkspace(1000)
  const stat = await fs.stat(ws.filePath)
  let connected = false

  await assert.rejects(
    () =>
      runUpload(
        ws.filePath,
        { chat: '@store', 'chunk-size': '400', encrypt: true },
        encryptedRun(fakeClient(), ws, {
          connect: async () => {
            connected = true
          },
          askNewPassword: async () => {
            throw new Error('--encrypt needs a terminal')
          },
        }),
      ),
    /--encrypt needs a terminal/,
  )

  assert.equal(connected, false)
  assert.equal(await loadState(stateKey(ws.filePath, stat.size, stat.mtimeMs), ws.configDir), null)
})
```

Append to `test/uploads.test.js` (add `passwordDeps` to its helpers import and `import { parseManifest } from '../src/manifest.js'`):

```js
test('a batch with --encrypt asks for one password, and every file gets its own salt', async () => {
  const ws = await tempWorkspace([500, 300])
  const client = fakeClient()
  const asked = []

  const { failed } = await runUploads(
    ws.paths,
    { chat: '@store', 'chunk-size': '400', yes: true, encrypt: true },
    { ...uploadDeps(client), ...passwordDeps({ asked }), configDir: ws.configDir, partSize: 128, silent: true },
  )

  assert.equal(failed, 0)
  assert.deepEqual(asked, ['new'])

  const salts = client.messages
    .filter((m) => m.fileName.endsWith('.manifest.json'))
    .map((m) => parseManifest(m.bytes).enc.salt)

  assert.equal(salts.length, 2)
  assert.notEqual(salts[0], salts[1])
})
```

Append to `test/status.test.js` (add `import { promises as fs } from 'node:fs'`, `import path from 'node:path'` and `saveState, stateKey` from `../src/state.js` to its imports if missing):

```js
test('the resume command of an encrypted upload carries --encrypt', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)

  const file = path.join(configDir, 'data.tar')
  await fs.writeFile(file, Buffer.alloc(1000))
  const stat = await fs.stat(file)

  await saveState(
    stateKey(file, stat.size, stat.mtimeMs),
    {
      id: 'telstore-20260914-ab12cd',
      chat: '@my_backups',
      path: file,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      chunkSize: 400,
      enc: { salt: '0'.repeat(32), check: '0'.repeat(64) },
      done: {},
    },
    configDir,
  )

  assert.match(await report(configDir), new RegExp(`Resume\\s+npx telstore ${file} --encrypt$`, 'm'))
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/upload.test.js test/uploads.test.js test/status.test.js`
Expected: the new tests FAIL (plaintext is sent; no `enc` in the record; no `--encrypt` in the resume line).

- [ ] **Step 3: Implement in `src/commands/upload.js`**

Imports — add:

```js
import { createHash } from 'node:crypto'

import { chunkCipher, deriveKeys, newIv, newSalt, passwordCheck, sealManifest } from '../cipher.js'
import { askNewPassword as realAskNewPassword, askPassword as realAskPassword } from '../password.js'
```

`runUpload` deps — add after `filesAfterNote = false,`:

```js
    askNewPassword = realAskNewPassword,
    askPassword = realAskPassword,
    // A batch asks once and hands the answer to every file, rather than once per file.
    secret = null,
```

Immediately after the block that refuses a resume to a different chat (`if (resuming && state.chat !== String(chat)) { ... }`), and before `if (!resuming) {`, add:

```js
  const encrypt = Boolean(options.encrypt)

  // An unfinished backup is encrypted or it is not, and the chunks already in the chat decide
  // which. Carrying on the other way would mix plaintext and ciphertext in one backup no manifest
  // could describe, so a run that disagrees is refused the way a disagreeing --chunk-size is.
  if (resuming && Boolean(state.enc) !== encrypt) {
    const file = stateFile(key, configDir)

    throw new Error(
      state.enc
        ? `This unfinished backup is encrypted, and this run has no --encrypt. Run again with ` +
            `--encrypt to carry on, or delete ${file} and run again to start a new backup, which ` +
            'leaves the chunks already sent sitting in the chat with nothing to point at them.'
        : `This unfinished backup is not encrypted, and this run asks for --encrypt — the chunks ` +
            `already in ${state.chat} went up as they are. Run again without --encrypt to carry ` +
            `on, or delete ${file} and run again to start a new, encrypted backup, which leaves ` +
            'the chunks already sent sitting in the chat with nothing to point at them.',
    )
  }

  let keys = null
  let enc = null

  if (encrypt && resuming) {
    if (
      typeof state.enc?.salt !== 'string' ||
      !/^[0-9a-f]{32}$/.test(state.enc.salt) ||
      typeof state.enc.check !== 'string'
    ) {
      throw new Error(
        'The record of this unfinished backup says it is encrypted but does not carry what is ' +
          `needed to carry on encrypting it. ${stateFile(key, configDir)} is damaged — delete it ` +
          'and run again to start a new backup, which leaves the chunks already sent sitting in ' +
          'the chat with nothing to point at them.',
      )
    }

    // The password is asked for again rather than kept: nothing on this disk can decrypt the
    // chunks already in the chat. The check refuses a different one, which would put two keys
    // into a single backup.
    const password =
      secret?.password ??
      (await askPassword(`Password for ${state.id}${state.enc.hint ? ` (hint: ${state.enc.hint})` : ''}: `))

    keys = await deriveKeys(password, state.enc.salt)

    if (passwordCheck(keys) !== state.enc.check) {
      throw new Error(
        `That is not the password backup ${state.id} was started with, and the chunks already in ` +
          `${state.chat} are encrypted with that one. Run again and type the first password, or ` +
          `delete ${stateFile(key, configDir)} and run again to start a new backup, which leaves ` +
          'the chunks already sent sitting in the chat with nothing to point at them.',
      )
    }

    enc = state.enc
  } else if (encrypt) {
    // Before the record and before the connection: a run that cannot get a password has written
    // nothing and opened nothing.
    const chosen = secret ?? (await askNewPassword())
    const salt = newSalt()

    keys = await deriveKeys(chosen.password, salt)
    enc = { salt, check: passwordCheck(keys), ...(chosen.hint ? { hint: chosen.hint } : {}) }
  }
```

In the new-state object inside `if (!resuming) { state = { ... } }`, add after `chunkSize,`:

```js
      ...(enc ? { enc } : {}),
```

After `log(`File   ${absPath} (...)`)`, add:

```js
  if (enc) log(`Lock   encrypted${enc.hint ? ` (hint: ${enc.hint})` : ''}`)
```

Inside the chunk loop, just before `const { inputFile, sha256 } = await uploadRange(...)`:

```js
            // A fresh iv per attempt at this chunk; see newIv in src/cipher.js for why it is never
            // derived from the index.
            const iv = keys ? newIv() : null
            const cipher = keys ? chunkCipher(keys.chunkKey, iv) : null
            const plain = keys ? createHash('sha256') : null
```

and add to `uploadRange`'s options:

```js
              transform: cipher
                ? (bytes, at) => {
                    plain.update(bytes)
                    return cipher.apply(bytes, at)
                  }
                : undefined,
```

Change the `markChunkDone` entry to:

```js
              {
                msgId: message.id,
                size: chunk.length,
                sha256,
                ...(cipher ? { iv, plainSha256: plain.digest('hex') } : {}),
              },
```

Replace the manifest construction (`const manifest = buildManifest({ ... })`) with:

```js
    let manifest = buildManifest({
      id: state.id,
      name: path.basename(absPath),
      size: stat.size,
      chunkSize,
      note,
      enc: enc ? { salt: enc.salt, ...(enc.hint ? { hint: enc.hint } : {}) } : null,
      chunks: chunks.map((chunk) => ({ i: chunk.i, ...state.done[String(chunk.i)] })),
    })

    if (keys) manifest = sealManifest(manifest, keys, plainHashesOf(state, chunks, stateFile(key, configDir)))
```

and in the `manifestCaption({ ... })` call add:

```js
        encrypted: Boolean(keys),
        hint: manifest.enc?.hint ?? null,
```

Add this function above `runUpload`:

```js
// The plaintext hashes the seal carries, read from the record that collected them one chunk at
// a time — possibly across several runs. A record that lost one cannot produce a manifest that
// decrypts, and sending one anyway would be a backup that restores to nothing.
function plainHashesOf(state, chunks, file) {
  return chunks.map((chunk) => {
    const entry = state.done[String(chunk.i)]

    if (
      typeof entry?.iv !== 'string' ||
      !/^[0-9a-f]{16}$/.test(entry.iv) ||
      typeof entry.plainSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.plainSha256)
    ) {
      throw new Error(
        `The record of this unfinished backup has no encryption details for chunk ${chunk.i + 1}, ` +
          `so telstore cannot write a manifest that decrypts it. ${file} is damaged — delete it ` +
          'and run again to start a new backup, which leaves the chunks already sent sitting in ' +
          'the chat with nothing to point at them.',
      )
    }

    return entry.plainSha256
  })
}
```

`runUploads` — add to its deps: `askNewPassword = realAskNewPassword,`. After the `if (!options.yes) { ... }` confirmation block and before `let shared = null`:

```js
  // Once, after the list has been confirmed: nobody should type a password for a batch they are
  // about to cancel. Every file still gets a salt of its own inside runUpload.
  const secret = options.encrypt ? await askNewPassword() : null
```

and add `secret,` to the `perFile` object.

- [ ] **Step 4: Implement in `src/commands/status.js`**

Replace `resumeCommand`'s return with:

```js
  // An encrypted record refuses a run without --encrypt, so a line without it would be a command
  // telstore prints to be pasted and then turns away.
  const encrypt = state.enc ? ' --encrypt' : ''

  return `npx telstore ${shellArg(state.path)}${encrypt}${matches ? '' : ` --chat ${shellArg(state.chat)}`}`
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/upload.test.js test/uploads.test.js test/status.test.js` — PASS. `npm test` — all green.

- [ ] **Step 6: Commit**

```bash
git add src/commands/upload.js src/commands/status.js test/upload.test.js test/uploads.test.js test/status.test.js
git commit -m "feat: --encrypt on file and batch uploads, resumable"
```

---

### Task 7: `--encrypt` on stream upload and `tarc`

**Files:**
- Modify: `src/commands/upload-stream.js`
- Test: `test/upload-stream.test.js` (append)

**Interfaces:**
- Consumes: Tasks 1–5; `askNewPassword` from Task 4.
- Produces: `runStreamUpload` deps `askNewPassword`, `secret`. Stream record `done` entries gain `iv`, `plainSha256` when encrypted.

- [ ] **Step 1: Write the failing tests**

Append to `test/upload-stream.test.js`. Add `import { randomBytes } from 'node:crypto'`, `import { chunkCipher, openManifest } from '../src/cipher.js'`, and extend the helpers import with `PASSWORD, passwordDeps, sharesRun`.

```js
test('--encrypt sends the command output as ciphertext under a manifest that opens', async () => {
  const ws = await workspace()
  const client = fakeClient()
  const produced = [randomBytes(100), randomBytes(100), randomBytes(50)]
  const content = Buffer.concat(produced)

  await runStreamUpload(
    'a.tar',
    ['tar', 'cf', '-', './a'],
    { 'chunk-size': '100', encrypt: true },
    streamDeps(client, ws, { ...passwordDeps({ hint: 'the cat' }), spawn: fakeSpawn(produced) }),
  )

  const sent = Buffer.concat(chunkMessages(client).map((m) => m.bytes))
  assert.equal(sent.length, content.length)
  assert.equal(sharesRun(sent, content), false)

  const manifest = parseManifest(manifestMessages(client).at(-1).bytes)
  const opened = await openManifest(manifest, PASSWORD)
  const clear = Buffer.concat(
    manifest.chunks.map((chunk, i) =>
      chunkCipher(opened.keys.chunkKey, chunk.iv).apply(chunkMessages(client)[i].bytes, 0),
    ),
  )

  assert.deepEqual(clear, content)
  assert.equal(manifest.enc.hint, 'the cat')
  assert.match(manifestMessages(client).at(-1).caption, /🔒 encrypted/)
})

test('a password that cannot be had stops a stream upload before the command starts', async () => {
  const ws = await workspace()
  const client = fakeClient()
  const spawn = fakeSpawn([TEN])

  await assert.rejects(
    () =>
      runStreamUpload(
        'a.tar',
        ['tar', 'cf', '-', './a'],
        { 'chunk-size': '10', encrypt: true },
        streamDeps(client, ws, {
          spawn,
          askNewPassword: async () => {
            throw new Error('--encrypt needs a terminal')
          },
        }),
      ),
    /--encrypt needs a terminal/,
  )

  assert.equal(spawn.calls.length, 0)
  assert.equal(client.messages.length, 0)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/upload-stream.test.js`
Expected: FAIL — the first sends plaintext; the second starts the command (spawn.calls is 1).

- [ ] **Step 3: Implement in `src/commands/upload-stream.js`**

Imports — add:

```js
import { createHash } from 'node:crypto'

import { chunkCipher, deriveKeys, newIv, newSalt, sealManifest } from '../cipher.js'
import { askNewPassword as realAskNewPassword } from '../password.js'
```

Deps — add after `onTempChunk = () => {},`:

```js
    askNewPassword = realAskNewPassword,
    secret = null,
```

After `const concurrency = settings.uploadConcurrency` and before `const id = newBackupId()`:

```js
  // Before the record, the connection and the command: a run that cannot get a password has
  // nothing to unwind, and nobody should watch pg_dump start before being asked for one. No
  // check value is kept — a stream is never resumed, so there is no second run to compare with.
  let keys = null
  let enc = null

  if (options.encrypt) {
    const chosen = secret ?? (await askNewPassword())
    const salt = newSalt()

    keys = await deriveKeys(chosen.password, salt)
    enc = { salt, ...(chosen.hint ? { hint: chosen.hint } : {}) }
  }
```

After `log(`Name   ${name} (chunks of ${formatBytes(chunkSize)})`)`:

```js
  if (enc) log(`Lock   encrypted${enc.hint ? ` (hint: ${enc.hint})` : ''}`)
```

Just before the `uploadRange` call inside the loop:

```js
              const iv = keys ? newIv() : null
              const cipher = keys ? chunkCipher(keys.chunkKey, iv) : null
              const plain = keys ? createHash('sha256') : null
```

and add to `uploadRange`'s options:

```js
                transform: cipher
                  ? (bytes, at) => {
                      plain.update(bytes)
                      return cipher.apply(bytes, at)
                    }
                  : undefined,
```

Change the `markChunkDone` entry to:

```js
                {
                  msgId: message.id,
                  size: filled.bytes,
                  sha256,
                  ...(cipher ? { iv, plainSha256: plain.digest('hex') } : {}),
                },
```

Replace `const manifest = buildManifest({ ... })` with:

```js
      let manifest = buildManifest({
        id,
        name,
        size,
        chunkSize,
        note,
        enc,
        chunks: Array.from({ length: count }, (_, i) => ({ i, ...state.done[String(i)] })),
      })

      if (keys) {
        manifest = sealManifest(
          manifest,
          keys,
          Array.from({ length: count }, (_, i) => state.done[String(i)].plainSha256),
        )
      }
```

and add to its `manifestCaption({ ... })` call:

```js
          encrypted: Boolean(keys),
          hint: manifest.enc?.hint ?? null,
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/upload-stream.test.js` — PASS. `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/commands/upload-stream.js test/upload-stream.test.js
git commit -m "feat: --encrypt on uploads made from a command"
```

---

### Task 8: Restore decrypts, resumes against plaintext, reuses passwords in a batch

**Files:**
- Modify: `src/commands/restore.js`
- Test: `test/restore-encrypted.test.js` (new)

**Interfaces:**
- Consumes: `chunkCipher`, `decryptInPlace` (Task 1), `isEncrypted` (Task 2), `askPassword`, `unlockManifest` (Task 4), `encryptedBackup`, `passwordDeps` (Task 2 helpers).
- Produces: `runRestore` deps `askPassword`, `interactive`, `knownPasswords`; `runRestores` shares one `knownPasswords` array across ids.

- [ ] **Step 1: Write the failing tests**

Create `test/restore-encrypted.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

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

  await assert.rejects(
    () =>
      runRestore(
        backup.manifest.id,
        { out: path.join(dir, 'out.tar') },
        deps(chat([backup]), configDir, { interactive: () => false }),
      ),
    /is encrypted, and there is no terminal/,
  )
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/restore-encrypted.test.js`
Expected: FAIL — the restored file is ciphertext; wrong passwords are never asked for.

- [ ] **Step 3: Implement in `src/commands/restore.js`**

Imports — add:

```js
import { chunkCipher, decryptInPlace } from '../cipher.js'
import { askPassword as realAskPassword, unlockManifest } from '../password.js'
```

and change the manifest import to `import { isEncrypted, parseManifest, safeOutName } from '../manifest.js'`.

Change `scanPartial` to take what each chunk must hash to on disk:

```js
async function scanPartial(handle, manifest, log, expected) {
  let done = 0

  for (const chunk of manifest.chunks) {
    const digest = await hashRange(handle.fd, chunk.i * manifest.chunkSize, chunk.size)

    // Downloads run in order, so what is already present is a prefix. The first chunk that
    // does not match is where this run starts, and reading past it would hash gigabytes
    // nobody has written yet.
    if (digest !== expected(chunk)) break

    done += 1
    log(`Chunk ${chunk.i + 1}/${manifest.chunks.length} already restored, skipping.`)
  }

  return done
}
```

`runRestore` deps — add after `onBackupId = () => {},`:

```js
    askPassword = realAskPassword,
    interactive = () => Boolean(process.stdin.isTTY),
    // Passwords that opened an earlier backup in the same batch, tried before asking again.
    knownPasswords = [],
```

Right after `const manifest = parseManifest(await readMessageBytes(client, manifestMessage))`:

```js
    // Before the overwrite question and before the .partial: a password that cannot be had must
    // cost nothing, and nobody should answer [y/N] about a file telstore then cannot write.
    const opened = isEncrypted(manifest)
      ? await unlockManifest(manifest, { askPassword, interactive, known: knownPasswords, say: log })
      : null

    // What each finished chunk hashes to in the .partial. A decrypted chunk is plaintext there,
    // and only the sealed hash says what that plaintext must be.
    const onDisk = (chunk) => (opened ? opened.plainSha256[chunk.i] : chunk.sha256)
```

After `log(`Backup ${manifest.id}`)` add:

```js
    if (opened) log('Lock   encrypted')
```

Change `done = await scanPartial(handle, manifest, log)` to `done = await scanPartial(handle, manifest, log, onDisk)`.

In the chunk loop, right after the `if (sha256 !== chunk.sha256) { throw ... }` block and before `await note(chunk.i + 1)`:

```js
            // Only after the ciphertext has matched: that match is what proves these are the bytes
            // that went up, and the manifest's seal is what proves the hash itself. The plaintext
            // check that follows is the second one, and it exists for telstore's own mistakes.
            if (opened) {
              const clear = await decryptInPlace(
                handle,
                chunk.i * manifest.chunkSize,
                chunk.size,
                chunkCipher(opened.keys.chunkKey, chunk.iv),
              )

              if (clear !== opened.plainSha256[chunk.i]) {
                throw new Error(
                  `Chunk ${chunk.i + 1} matched its encrypted sha256 but decrypted to bytes that do ` +
                    'not match the manifest. That points at telstore rather than at the backup; ' +
                    `nothing was renamed, and the download is kept at ${partial} for inspection.`,
                )
              }
            }
```

`runRestores` — before `let shared = null` add `const passwords = []`, and add `knownPasswords: passwords,` to the `perId` object.

- [ ] **Step 4: Run the tests**

Run: `node --test test/restore-encrypted.test.js test/restore.test.js test/restores.test.js` — PASS. `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/commands/restore.js test/restore-encrypted.test.js
git commit -m "feat: restore decrypts encrypted backups after the ciphertext check"
```

---

### Task 9: Restore into a command decrypts before handing a byte over

**Files:**
- Modify: `src/commands/restore-stream.js`
- Test: `test/restore-stream.test.js` (append)

**Interfaces:**
- Consumes: Task 1 (`chunkCipher`, `decryptInPlace`), Task 2 (`isEncrypted`), Task 4 (`askPassword`, `unlockManifest`).
- Produces: `runRestoreStream` deps `askPassword`, `interactive`.

- [ ] **Step 1: Write the failing tests**

Append to `test/restore-stream.test.js` (add `encryptedBackup, passwordDeps` to its helpers import and `import { randomBytes } from 'node:crypto'`; `chunkFileName` to its manifest import):

```js
async function encryptedChat(content) {
  const { manifest, pieces } = await encryptedBackup({ name: 'data.tar.gz', content, chunkSize: 4 })
  const manifestBytes = serializeManifest(manifest)
  const messages = [
    ...pieces.map((piece) => ({ id: piece.msgId, fileName: chunkFileName(manifest.id, piece.i), bytes: piece.bytes })),
    { id: 2000, fileName: manifestFileName(manifest.id), bytes: manifestBytes },
  ]

  return { id: manifest.id, content, messages, manifest, manifestBytes }
}

test('an encrypted backup reaches the command as plaintext', async () => {
  const ws = await workspace()
  const backup = await encryptedChat(randomBytes(10))
  const child = fakeChild()
  const { deps } = fakeChat(backup, child, ws, passwordDeps())

  await runRestoreStream(backup.id, ARGV, {}, deps)

  assert.deepEqual(child.bytes(), backup.content)
})

test('an encrypted backup with no terminal for its password starts no command', async () => {
  const ws = await workspace()
  const backup = await encryptedChat(randomBytes(10))
  const child = fakeChild()
  const { deps, spawn } = fakeChat(backup, child, ws, { ...passwordDeps(), interactive: () => false })

  await assert.rejects(() => runRestoreStream(backup.id, ARGV, {}, deps), /no terminal/)
  assert.equal(spawn.calls.length, 0)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/restore-stream.test.js`
Expected: FAIL — the command receives ciphertext; the command is spawned without a password.

- [ ] **Step 3: Implement in `src/commands/restore-stream.js`**

Imports — add:

```js
import { chunkCipher, decryptInPlace } from '../cipher.js'
import { askPassword as realAskPassword, unlockManifest } from '../password.js'
```

and change the manifest import to `import { isEncrypted, parseManifest } from '../manifest.js'`.

Deps — add after `requireGzipName = false,`:

```js
    askPassword = realAskPassword,
    interactive = () => Boolean(process.stdin.isTTY),
```

After the `requireGzipName` check block and before `log(`Backup ${backupId}`)`:

```js
    // Before the command is started, for the reason the gzip check above runs before the
    // download: a restore that cannot be decrypted should cost nothing, and a command started
    // for it would be a tar waiting on a pipe that is never going to carry anything.
    const opened = isEncrypted(manifest)
      ? await unlockManifest(manifest, { askPassword, interactive, say: log })
      : null
```

After `log(`Name   ${manifest.name} (...)`)` add:

```js
    if (opened) log('Lock   encrypted')
```

In the chunk loop, after the `if (sha256 !== chunk.sha256) { throw ... }` block and before the `writeChunkTo` comment:

```js
          // The rule this file keeps — no byte reaches the command before its chunk is verified —
          // now means verified as plaintext: decrypted in the temp file, hashed against the seal,
          // and only then pumped.
          if (opened) {
            const clear = await decryptInPlace(handle, 0, size, chunkCipher(opened.keys.chunkKey, chunk.iv))

            if (clear !== opened.plainSha256[chunk.i]) {
              throw new Error(
                `Chunk ${chunk.i + 1} matched its encrypted sha256 but decrypted to bytes that do ` +
                  'not match the manifest. That points at telstore rather than at the backup. ' +
                  `${received(childArgv, written)}`,
              )
            }
          }
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/restore-stream.test.js` — PASS. `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/commands/restore-stream.js test/restore-stream.test.js
git commit -m "feat: restore into a command decrypts each chunk before handing it over"
```

---

### Task 10: Join decrypts while copying

**Files:**
- Modify: `src/commands/join.js`
- Test: `test/join.test.js` (append)

**Interfaces:**
- Consumes: Task 1 (`chunkCipher`), Task 2 (`isEncrypted`), Task 4 (`askPassword`, `unlockManifest`).
- Produces: `runJoin` deps `askPassword`, `interactive`.

- [ ] **Step 1: Write the failing tests**

Append to `test/join.test.js` (add `encryptedBackup, passwordDeps` to its helpers import):

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/join.test.js`
Expected: FAIL — the joined file is ciphertext; no password is asked.

- [ ] **Step 3: Implement in `src/commands/join.js`**

Imports — add:

```js
import { chunkCipher } from '../cipher.js'
import { askPassword as realAskPassword, unlockManifest } from '../password.js'
```

and change the manifest import to `import { chunkFileName, isEncrypted, parseManifest, safeOutName } from '../manifest.js'`.

Replace `copyChunk` with:

```js
// Copies one chunk file into place and hashes exactly the bytes it copied. The length was
// checked up front, and is checked again here because the file is read now, not then: a
// download still being written, or replaced in between, is a different file from the one
// that was stat'd.
//
// For an encrypted backup the file holds ciphertext: that is what is hashed against the
// manifest, and the plaintext written into place is hashed against the seal.
async function copyChunk({ file, handle, offset, chunk, count, buffer, advance, cipher = null, plainSha256 = null }) {
  const name = path.basename(file)
  const source = await fs.open(file, 'r')
  const hash = createHash('sha256')
  const plain = cipher ? createHash('sha256') : null
  let copied = 0

  try {
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, copied)

      if (bytesRead === 0) break

      if (copied + bytesRead > chunk.size) {
        throw new Error(`${name} grew past the ${chunk.size} bytes the manifest records while it was being read.`)
      }

      const read = buffer.subarray(0, bytesRead)
      const out = cipher ? cipher.apply(read, copied) : read

      hash.update(read)
      plain?.update(out)
      await writeAll(handle, out, bytesRead, offset + copied)
      copied += bytesRead
      advance(bytesRead)
    }
  } finally {
    await source.close()
  }

  if (copied !== chunk.size) {
    throw new Error(`${name} has ${copied} bytes, the manifest records ${chunk.size} bytes.`)
  }

  if (hash.digest('hex') !== chunk.sha256) {
    throw new Error(
      `${name} does not match the sha256 the manifest records for chunk ${chunk.i + 1}/${count}. ` +
        'It is damaged or belongs to another backup — download it again.',
    )
  }

  if (plain && plain.digest('hex') !== plainSha256) {
    throw new Error(
      `${name} matched its encrypted sha256 but decrypted to bytes that do not match the ` +
        `manifest for chunk ${chunk.i + 1}/${count}. That points at telstore rather than at the download.`,
    )
  }
}
```

`runJoin` deps — add after `onTempChunk = () => {},`:

```js
    askPassword = realAskPassword,
    interactive = () => Boolean(process.stdin.isTTY),
```

After `await checkChunkFiles(manifest, files, dir)`:

```js
  // After the files are known to be there — that costs nothing and needs no password — and
  // before the overwrite question, for restore's reason: nobody should answer [y/N] about a
  // file telstore then cannot decrypt.
  const opened = isEncrypted(manifest)
    ? await unlockManifest(manifest, { askPassword, interactive, say: log })
    : null
```

After `log(`Backup ${manifest.id}`)` add `if (opened) log('Lock   encrypted')`.

In the `copyChunk({ ... })` call add:

```js
          cipher: opened ? chunkCipher(opened.keys.chunkKey, chunk.iv) : null,
          plainSha256: opened ? opened.plainSha256[chunk.i] : null,
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/join.test.js` — PASS. `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/commands/join.js test/join.test.js
git commit -m "feat: join decrypts encrypted backups offline"
```

---

### Task 11: The `--encrypt` flag, its refusal elsewhere, HELP, and `verify`'s lock line

**Files:**
- Modify: `src/cli.js` (`OPTIONS`, `HELP`, `route`)
- Modify: `src/commands/verify.js` (header)
- Test: `test/cli.test.js`, `test/verify.test.js` (append)

**Interfaces:**
- Consumes: `isEncrypted` (Task 2).
- Produces: `route` returns `options.encrypt === true` for uploads and throws for any other command that carries it.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.js`:

```js
test('--encrypt is an upload option, for a file, a command and tarc', () => {
  assert.equal(route(['a.tar', '--encrypt']).options.encrypt, true)
  assert.equal(route(['a.tar', '--encrypt', '--', 'tar', 'cf', '-', './a']).options.encrypt, true)

  const tarc = route(['tarc', 'a', './a', '--encrypt'])
  assert.equal(tarc.command, 'upload')
  assert.equal(tarc.options.encrypt, true)
})

for (const line of [
  ['restore', 'telstore-20260914-ab12cd', '--encrypt'],
  ['tarx', 'telstore-20260914-ab12cd', '--encrypt'],
  ['join', 'x.manifest.json', '--encrypt'],
  ['verify', 'telstore-20260914-ab12cd', '--encrypt'],
  ['list', '--encrypt'],
]) {
  test(`--encrypt is refused on ${line[0]}, which sees encryption in the manifest`, () => {
    assert.throws(() => route(line), /--encrypt applies to uploads only/)
  })
}

test('the help names --encrypt', () => {
  assert.match(HELP, /--encrypt/)
  assert.ok(OPTIONS.encrypt)
})
```

Append to `test/verify.test.js`:

```js
test('an encrypted backup is verified without a password, and says it is locked', async () => {
  const configDir = await workspace()
  const backup = fakeBackup()
  const out = collect()
  const encrypted = {
    ...backup.manifest,
    v: 2,
    enc: { salt: '0'.repeat(32), hint: 'the cat', sealed: 'AAAA' },
    chunks: backup.manifest.chunks.map((chunk) => ({ ...chunk, iv: '0'.repeat(16) })),
  }

  const result = await runVerify(
    ID,
    {},
    deps(backup, configDir, out, { manifestBytes: serializeManifest(encrypted) }),
  )

  assert.deepEqual(result.damaged, [])
  assert.match(out.text(), /Lock {3}encrypted \(hint: the cat\)/)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/cli.test.js test/verify.test.js`
Expected: FAIL — `Unknown option '--encrypt'`; no `Lock` line.

- [ ] **Step 3: Implement in `src/cli.js`**

Add to `OPTIONS` after `note: { type: 'string' },`: `encrypt: { type: 'boolean' },`

In `HELP`, add after the `--note` option block:

```
  --encrypt                   Encrypt the contents with a password before they leave this
                              machine. Asks for the password twice and for an optional hint,
                              which is shown in the chat as plain text. restore, tarx and join
                              see from the manifest that a backup is encrypted and ask for the
                              password themselves. The file name, note and size stay readable,
                              and a forgotten password is a lost backup.
```

Rename the existing `export function route(argv) {` to `function routeLine(argv) {` and add below it:

```js
// Encryption is decided when a backup is made; every command that reads one learns it from the
// manifest. A flag beside a restore would read as "decrypt with this", which it would not be,
// and a flag that silently does nothing is one nobody can predict without the source.
export function route(argv) {
  const parsed = routeLine(argv)

  if (parsed.options.encrypt && parsed.command !== 'upload' && parsed.command !== 'help') {
    throw new Error(
      '--encrypt applies to uploads only. restore, tarx and join see from the manifest that a ' +
        'backup is encrypted and ask for its password by themselves.',
    )
  }

  return parsed
}
```

- [ ] **Step 4: Implement in `src/commands/verify.js`**

Change the manifest import to include `isEncrypted`. After the `File` log line in `runVerify` add:

```js
    // Said, not checked: verify never has the password and never needs it. What it asks the chat
    // about — presence, file name, length — is the same for ciphertext.
    if (isEncrypted(manifest)) {
      log(`Lock   encrypted${manifest.enc.hint ? ` (hint: ${manifest.enc.hint})` : ''}`)
    }
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/cli.test.js test/verify.test.js test/bin.test.js` — PASS (`bin.test.js` also proves no teleproto import crept into the startup path). `npm test` — all green.

- [ ] **Step 6: Commit**

```bash
git add src/cli.js src/commands/verify.js test/cli.test.js test/verify.test.js
git commit -m "feat: --encrypt flag, refused outside uploads; verify shows the lock"
```

---

### Task 12: Documentation

**Files:**
- Create: `docs/design/encryption.md`
- Modify: `CLAUDE.md` (table), `docs/design/data-integrity.md`, `docs/design/settings-and-flags.md`, `docs/design/captions.md`, `README.md`

- [ ] **Step 1: Write `docs/design/encryption.md`**

```markdown
# Encryption

- **Contents are AES-256-CTR, not an AEAD per chunk, because CTR keeps the length.** GCM over each
  chunk adds a tag and breaks the rule everything else rests on: chunk `i` sits at
  `i * chunkSize`, and every chunk but the last is exactly `chunkSize` (`parseManifest`). It would
  also force the file path to write each encrypted chunk to a temp file first, since
  `uploadRange` reads the source by offset — 1800MB of extra disk per chunk at the default size.
  With CTR, `uploadRange` gets a `transform` hook and nothing about layout, resume or
  `MAX_CHUNKS` changes.
- **CTR is malleable; the manifest is what makes it tamper-evident.** The ciphertext sha256 of
  every chunk is in the GCM additional data of the manifest's seal, so nobody without the key
  can change what a restore expects a chunk to hash to, and the ciphertext check every restore
  already made catches any change to a chunk before a byte is decrypted.
- **The plaintext hash is a second check, sealed.** Redundant cryptographically once the
  ciphertext hash is authenticated; it exists for telstore's own bugs (a wrong counter offset
  decrypts to plausible garbage with every ciphertext hash matching) and it is what the restore
  resume scan compares against, since the `.partial` holds plaintext. Sealed rather than open
  because a plaintext hash in the chat lets anyone confirm the backup is a copy of a file they
  already have.
- **Restore order, every path: ciphertext sha256, then decrypt, then plaintext sha256.** File
  restore decrypts in place in the `.partial`; restore into a command decrypts the temp chunk
  before `writeChunkTo`; join decrypts each buffer as it copies.
- **Keys.** scrypt (the `src/token.js` parameters, pinned to manifest version 2) over a 16-byte
  salt per backup, then HKDF into a chunk key and a manifest key — two keys because GCM is CTR
  inside, and one key for both invites a counter-block collision.
- **Nonces are random per attempt at a chunk, never derived from its index.** A run that dies
  mid-chunk leaves parts on Telegram's servers; a derived nonce would put the next run's attempt
  — different bytes, if the file changed — under the same keystream.
- **Encrypted manifests are version 2; plain ones stay version 1 byte for byte.** An older
  telstore checks `v` and nothing else it does not know. Given `v: 1` plus an `enc` field it would
  download the ciphertext, match every sha256 and the length, rename, and print Done over random
  bytes. An older `delete` still works, through the lenient `parseManifestJson`.
- **The additional data is built from the fields in one fixed order, never by re-serializing the
  parsed object**, whose key order belongs to a file a person can edit. The readable fields —
  name, note, hint — are covered too: not secret, but a hint changed by someone else is a line of
  their choosing that telstore prints above a password prompt.
- **Passwords come from a terminal only**, the rule `token` keeps. A resumed upload asks again
  and compares an HMAC check kept in the record; neither the password nor a key touches disk.
- **The hint is capped at 100 characters because that is what the caption has left** — measured
  2026-09-14, the worst card without encryption is 899 of 1024.
- **What is not promised:** the name, note, size, chunk count, dates and hint are readable by
  anyone who can read the chat, and a forgotten password is a lost backup.

## Measured

<!-- Task 13 fills this in from the e2e run: chunk size, restore wall time with and without
     --encrypt, the share the decryption pass took, the machine. -->
```

- [ ] **Step 2: `CLAUDE.md` table**

Add a row to the "Before you change / Read" table:

```
| `src/cipher.js`, `src/password.js`, `--encrypt`, anything that encrypts or decrypts chunk bytes | `docs/design/encryption.md`, `docs/design/data-integrity.md` |
```

- [ ] **Step 3: `docs/design/data-integrity.md`** — append a bullet:

```markdown
- **An encrypted backup is manifest version 2, and every restore path checks it in one order:
  ciphertext sha256, then decrypt, then plaintext sha256.** The version bump is what stops an
  older telstore restoring ciphertext as the file with every check passing; the order is what
  keeps "no byte is used before its chunk is verified" true once bytes need decrypting.
  `docs/design/encryption.md` has the construction and why.
```

- [ ] **Step 4: `docs/design/settings-and-flags.md`** — in the "flags with no setting behind them" bullet, change "Five flags" to "Six flags" and add, before the `--token` clause:

```
`--encrypt` encrypts one upload (stored, it would make every upload for months ask for a
password somebody set once and forgot, and it is refused on every command that reads a backup,
because those learn it from the manifest),
```

- [ ] **Step 5: `docs/design/captions.md`** — append a bullet:

```markdown
- **An encrypted backup's card carries `🔒 encrypted` and, when there is one, `💡 <hint>`**, between
  the note and the restore line. Both are optional markers, like the note, so every older card
  still parses. `list` shows a `LOCK` column only when some row is encrypted — the `NOTE` rule —
  with the hint shortened to 40 characters, because that is where someone who forgot a password
  looks first. The hint `restore` prints above its prompt comes from the manifest, which is
  authenticated, never from the caption, which is not.
```

- [ ] **Step 6: `README.md`**

Add a section after "## A backup made from a command":

~~~markdown
## Encrypting a backup

```bash
npx telstore photos.tar --encrypt
npx telstore tarc photos.tar.gz ./photos --encrypt
```

telstore asks for a password twice and for an optional hint, then encrypts every chunk before
it leaves the machine (AES-256-CTR, the key derived with scrypt, the manifest sealed with
AES-256-GCM). `restore`, `tarx` and `join` see that a backup is encrypted, print its hint, and
ask for the password. The hint is shown in the chat as plain text — telstore refuses one that
contains the password.

What stays readable to anyone who can read the chat: the file name, the note, the size, the
number of chunks, the dates and the hint. **A forgotten password is a lost backup** — nothing
can recover it. The password is only ever typed at a terminal; for unattended encrypted
backups, use `--` with a key-based tool such as `age`.
~~~

Replace the limits bullet `- **Your data is not encrypted.** ...` with:

```markdown
- **Your data is not encrypted unless you pass `--encrypt`.** Without it, don't upload anything
  you would mind sitting on someone else's infrastructure. With it, the contents are encrypted
  but the file name, note, size and hint are not, and a forgotten password cannot be recovered.
```

- [ ] **Step 7: Commit**

```bash
git add docs/design/encryption.md CLAUDE.md docs/design/data-integrity.md docs/design/settings-and-flags.md docs/design/captions.md README.md
git commit -m "docs: encryption design, README and the docs it touches"
```

---

### Task 13: Verification against a real terminal and a real account

**Files:**
- Modify: `docs/design/encryption.md` (the "Measured" section)

- [ ] **Step 1: Full suite**

Run: `npm test` — expected all green. Paste the summary line into the task report.

- [ ] **Step 2: The prompt under a real pty**

Run, pacing input like a human (`docs/design/terminal-prompts.md`):

```bash
dd if=/dev/urandom of=/tmp/claude-enc-probe.bin bs=1k count=4 2>/dev/null
( sleep 1.5; echo 'pw one'; sleep 0.5; echo 'pw one'; sleep 0.5; echo 'the cat' ) \
  | HOME=$(mktemp -d) script -qec "node bin/telstore.js /tmp/claude-enc-probe.bin --encrypt --chat me" /dev/null
```

Expected: asterisks appear while each password is typed, the passwords never appear on screen,
the hint does, and the run then stops at "Not logged in" (the temporary `HOME` has no session) —
which proves the password is asked before the connection. Then run it again and press Ctrl-C at
the first `Password:` prompt: the process leaves at once and the terminal echoes typed characters
afterwards.

- [ ] **Step 3: The `e2e` skill**

Invoke the `e2e` skill and follow it exactly (temporary `HOME`, the throwaway chat, cleanup of only
this run's ids). In addition to its non-optional checks, run with `--encrypt`:

1. A file ≤ 10MB (the `SaveFilePart` branch) and a file > 10MB (the `SaveBigFilePart` branch):
   upload, `verify`, `restore`, and compare sha256 of the restored file with the source.
2. `tarc … --encrypt` then `tarx`, and compare the extracted tree with the source tree
   (not the archive bytes — `docs/design/settings-and-flags.md` says why).
3. Download one chunk from the chat by hand and confirm it is not the plaintext
   (`cmp` against the matching source range must differ).
4. Timing: restore the same > 10MB backup encrypted and plain, three runs each, and record wall
   time; the difference is the cost of the decryption pass.

- [ ] **Step 4: Record the measurement**

Replace the comment under `## Measured` in `docs/design/encryption.md` with what was measured:
date, chunk size, file size, the three timings each way, the machine, and — as the other design
docs do — what the measurement could not see.

- [ ] **Step 5: Commit**

```bash
git add docs/design/encryption.md
git commit -m "docs: measure what encryption costs a real restore"
```
