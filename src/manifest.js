import { randomBytes } from 'node:crypto'

import { countChunks } from './chunking.js'

export const MANIFEST_VERSION = 1

export function newBackupId(now = new Date(), randomHex = () => randomBytes(3).toString('hex')) {
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  return `telstore-${yyyy}${mm}${dd}-${randomHex()}`
}

// The day a backup id carries, as the UTC second that day began. newBackupId stamps it above
// from the clock of the machine making the backup, so it is that machine's idea of the day
// rather than Telegram's — which is why the one reader of this (delete's walk of the chat)
// gives it a day of slack and only ever uses it as a floor.
//
// A date that does not exist is not a day: `telstore-20269999-abc` would otherwise roll over
// into a year's time and read as a floor above everything in the chat, which is an early stop
// nobody would see. Null instead, and the caller falls back to a bound it can prove.
const BACKUP_ID_DAY = /^telstore-(\d{4})(\d{2})(\d{2})-[0-9a-f]+$/

export function backupIdDay(id) {
  const match = BACKUP_ID_DAY.exec(String(id))

  if (!match) return null

  const [year, month, day] = match.slice(1).map(Number)
  const at = new Date(Date.UTC(year, month - 1, day))

  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return null
  }

  return Math.floor(at.getTime() / 1000)
}

// The infix in every chunk's file name. A constant rather than a literal for the same reason
// MANIFEST_SUFFIX is one: there are two readers of that name now — the writer below and
// isChunkFileName — and a reader that disagrees with the writer by one character finds
// nothing at all.
const CHUNK_INFIX = '.part'

export function chunkFileName(id, i) {
  return `${id}${CHUNK_INFIX}${String(i + 1).padStart(4, '0')}`
}

// Whether a document in a chat is a chunk of this backup, decided by the file name telstore
// itself wrote and not by the caption beside it — the rule findManifestMessage already keeps,
// for the same reason: a caption is text a person can edit and a file name is not.
//
// The number is checked but never read back. What the caller needs is which backup a document
// belongs to, and a chunk whose index says something impossible is still that backup's chunk.
// What the check is for is the other direction: without it `<id>.partial` or `<id>.part.bak`
// — names telstore never writes, but names a person can give a file they upload themselves —
// would be read as chunks of a backup and destroyed along with it.
export function isChunkFileName(id, fileName) {
  if (typeof fileName !== 'string') return false

  const prefix = `${id}${CHUNK_INFIX}`

  if (!fileName.startsWith(prefix)) return false

  const number = fileName.slice(prefix.length)

  return number.length > 0 && /^[0-9]+$/.test(number)
}

// The suffix telstore has written on every manifest since version 1, and what `list` picks
// a manifest out of a chat by. One definition, because a reader that disagrees with the
// writer by one character finds nothing at all.
export const MANIFEST_SUFFIX = '.manifest.json'

export function manifestFileName(id) {
  return `${id}${MANIFEST_SUFFIX}`
}

export function buildManifest({
  id,
  name,
  size,
  chunkSize,
  chunks,
  createdAt = new Date().toISOString(),
  note = null,
}) {
  return {
    v: MANIFEST_VERSION,
    id,
    name,
    size,
    chunkSize,
    createdAt,
    // Absent rather than null when there is none: a manifest without a note has to be the
    // same file telstore wrote before the flag existed, down to the bytes.
    ...(note ? { note } : {}),
    chunks: [...chunks]
      .sort((a, b) => a.i - b.i)
      .map(({ i, msgId, size: chunkBytes, sha256 }) => ({ i, msgId, size: chunkBytes, sha256 })),
  }
}

export function serializeManifest(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

// parseManifest's own front door, on its own so delete can read a manifest body without
// the layout checks behind it.
export function parseManifestJson(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input)

  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Cannot read manifest: content is not valid JSON.')
  }
}

// Delete needs one thing from a manifest that restore does not, and none of the things
// restore needs. parseManifest is the wrong gate for it: it validates the chunk *layout*,
// because restore writes bytes at offsets computed from it — and a manifest that fails
// those checks is exactly the broken backup somebody is trying to delete, so refusing to
// read it here would leave the only way out through the Telegram app. It also never looks
// at msgId, which is the only field delete actually uses.
//
// Every id is checked before a single message is removed. A msgId is handed to Telegram as
// the name of something to destroy for good, and that is the one number nobody may guess
// at — so a manifest that cannot say it exactly is refused whole, rather than half-deleted
// and then left without the list that names the rest.
export function manifestMessageIds(manifest) {
  if (!Array.isArray(manifest?.chunks) || manifest.chunks.length === 0) {
    throw new Error('Manifest has no chunk list, so it cannot say which messages to remove.')
  }

  return manifest.chunks.map((chunk, index) => {
    const msgId = chunk?.msgId

    if (!Number.isSafeInteger(msgId) || msgId < 1) {
      throw new Error(
        `Manifest gives ${JSON.stringify(msgId)} as the message id of chunk ${index + 1}, ` +
          'which is not a message id. Deleting from this manifest could remove the wrong ' +
          'messages, so telstore is not deleting anything.',
      )
    }

    return msgId
  })
}

export function parseManifest(input) {
  const manifest = parseManifestJson(input)

  if (manifest.v !== MANIFEST_VERSION) {
    throw new Error(
      `Manifest uses version ${manifest.v}, this build of telstore only understands version ${MANIFEST_VERSION}.`,
    )
  }

  if (!Array.isArray(manifest.chunks) || manifest.chunks.length === 0) {
    throw new Error('Manifest has no chunk list.')
  }

  // The manifest comes off a chat, so nothing in it is trusted. The checks below are
  // arithmetic on these numbers, and arithmetic on a string or a null does not fail — it
  // produces a comparison that rejects the manifest for the wrong reason. A string size used
  // to be reported as "add up to 100, but the manifest records a file size of 100", which
  // sends the reader hunting for a difference that is not there.
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 0) {
    throw new Error(
      `Manifest records a file size of ${JSON.stringify(manifest.size)}, ` +
        'which is not a whole number of bytes.',
    )
  }

  // The note is decoration — nothing restores differently because of it — but a manifest is
  // a file a person can edit and send back, and a field holding something other than what it
  // claims to be is the point where telstore stops reading rather than guesses.
  if (manifest.note !== undefined && typeof manifest.note !== 'string') {
    throw new Error(
      `Manifest records a note of ${JSON.stringify(manifest.note)}, which is not text.`,
    )
  }

  if (!Number.isSafeInteger(manifest.chunkSize) || manifest.chunkSize < 1) {
    throw new Error(
      `Manifest records a chunk size of ${JSON.stringify(manifest.chunkSize)}, ` +
        'which is not a whole number of bytes above zero.',
    )
  }

  manifest.chunks.forEach((chunk, index) => {
    if (typeof chunk !== 'object' || chunk === null) {
      throw new Error(
        `Manifest entry for chunk ${index + 1} is not an object: ${JSON.stringify(chunk)}.`,
      )
    }

    if (!Number.isSafeInteger(chunk.size) || chunk.size < 0) {
      throw new Error(
        `Manifest records ${JSON.stringify(chunk.size)} bytes for chunk ${index + 1}, ` +
          'which is not a whole number of bytes.',
      )
    }

    if (chunk.i !== index) {
      throw new Error(`Manifest is missing chunk ${index}: the chunk list is not contiguous.`)
    }
  })

  const expectedChunks = countChunks(manifest.size, manifest.chunkSize)
  if (manifest.chunks.length !== expectedChunks) {
    throw new Error(`Manifest is missing ${expectedChunks - manifest.chunks.length} chunk(s).`)
  }

  const total = manifest.chunks.reduce((sum, chunk) => sum + chunk.size, 0)
  if (total !== manifest.size) {
    throw new Error(
      `Chunk sizes add up to ${total}, but the manifest records a file size of ${manifest.size}.`,
    )
  }

  // Restore writes chunk i at exactly offset i * chunkSize, so the layout must be
  // uniform: every chunk is chunkSize, except the last one which is the remainder.
  // A correct total with individually wrong sizes yields a file with a hole or
  // extra length while every per-chunk sha256 still matches — silently wrong data,
  // precisely what telstore must never produce.
  manifest.chunks.forEach((chunk, index) => {
    const expected = Math.min(manifest.chunkSize, manifest.size - index * manifest.chunkSize)
    if (chunk.size !== expected) {
      throw new Error(
        `Manifest records ${chunk.size} bytes for chunk ${index + 1}, but a layout of ` +
          `${manifest.chunkSize} bytes per chunk requires ${expected} bytes. ` +
          'This manifest describes the wrong chunk positions; restoring it would produce a corrupt file.',
      )
    }
  })

  return manifest
}
