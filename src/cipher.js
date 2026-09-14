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
// can edit. Every field is covered, the readable ones included. That proves the hint genuine only
// once a password opens the seal, and it is printed before then, so it is also made safe to print
// (terminalSafe in src/caption.js) rather than trusted because of this.
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
