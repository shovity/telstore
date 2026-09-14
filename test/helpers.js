import { promises as fs, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import { chunkCipher, deriveKeys, newIv, newSalt, sealManifest } from '../src/cipher.js'
import { buildManifest } from '../src/manifest.js'

// A config that passes assertLoggedIn. Tests that only need to get past the login gate
// say LOGGED_IN rather than restating what a valid session happens to look like.
export const LOGGED_IN = { session: 's', apiId: 1, apiHash: 'h' }

// Every temp directory a test asks for is removed when the process leaves, which is the one
// moment that arrives whether the test passed, failed or threw on the line before its own
// cleanup. Each test file is its own process under `node --test`, so this runs per file.
const created = []

process.on('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

export async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `telstore-${prefix}-`))
  created.push(dir)
  return dir
}

// Commands narrate through an injected log, so a test reads what the user would have seen.
export function collect() {
  const lines = []

  return {
    lines,
    log: (line) => lines.push(line),
    text: () => lines.join('\n'),
  }
}

/**
 * Fake client that collects every part by fileId and, when sendFile is called,
 * "seals" the uploaded content into a message with an increasing id.
 */
export function fakeClient({ failOnChunk = null } = {}) {
  const parts = new Map()
  const messages = []
  let nextId = 1000

  return {
    messages,
    async invoke(request) {
      const key = request.fileId.toString()
      if (!parts.has(key)) parts.set(key, [])
      parts.get(key).push({ index: request.filePart, bytes: Buffer.from(request.bytes) })
      return true
    },
    async sendFile(peer, { file, caption, attributes }) {
      const fileName = attributes?.[0]?.fileName ?? file.name
      const chunkIndex = messages.filter((m) => !m.fileName.endsWith('.manifest.json')).length

      if (failOnChunk !== null && chunkIndex === failOnChunk) {
        throw new Error('connection dropped mid-transfer')
      }

      const collected = parts.get(file.id?.toString()) ?? []
      const bytes = Buffer.concat(
        [...collected].sort((a, b) => a.index - b.index).map((p) => p.bytes),
      )

      nextId += 1
      const message = { id: nextId, peer, fileName, caption, bytes }
      messages.push(message)
      return message
    },
    async sendManifest(peer, { bytes, fileName, caption }) {
      nextId += 1
      const message = { id: nextId, peer, fileName, caption, bytes }
      messages.push(message)
      return message
    },
  }
}

// The seam every upload test drives the fake through: the real deps talk to teleproto,
// these four talk to fakeClient and nothing else.
export function uploadDeps(client) {
  return {
    connect: async () => client,
    sendChunk: async (c, peer, { inputFile, fileName, caption }) =>
      c.sendFile(peer, { file: inputFile, caption, attributes: [{ fileName }] }),
    sendManifest: async (c, peer, args) => c.sendManifest(peer, args),
    disconnect: async () => {},
  }
}

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
