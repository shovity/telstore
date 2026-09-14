import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { askConfirm } from '../confirm.js'
import { chunkCipher } from '../cipher.js'
import { chunkFileName, isEncrypted, parseManifest, safeOutName } from '../manifest.js'
import { askPassword as realAskPassword, unlockManifest } from '../password.js'
import { createProgress, formatBytes } from '../progress.js'

// Big enough that a 1800MB chunk is a couple of hundred reads, small enough that one buffer
// reused for every chunk is nothing next to the file being written.
const COPY_SIZE = 8 * 1024 * 1024

// A backup id becomes part of a path below, and it comes out of a file a person downloaded
// and can edit. Every id telstore writes is `telstore-YYYYMMDD-<hex>`; anything carrying a
// separator or a leading dot would have join read chunks from somewhere other than beside
// the manifest, so it is refused rather than followed.
function assertPlainId(id) {
  if (typeof id !== 'string' || !/^[\w.-]+$/.test(id) || id.startsWith('.')) {
    throw new Error(
      `The manifest gives ${JSON.stringify(id)} as its backup id, which is not a plain name, ` +
        'so telstore cannot tell which files beside it are its chunks.',
    )
  }
}

async function readManifest(manifestPath) {
  let bytes

  try {
    bytes = await fs.readFile(manifestPath)
  } catch (err) {
    throw new Error(`Cannot read the manifest ${manifestPath}: ${err.message}`)
  }

  return parseManifest(bytes)
}

// Every chunk is checked for presence and length before a byte is written, and every fault
// is named in one message: a download by hand that missed three files should cost one more
// trip to the chat, not three.
async function checkChunkFiles(manifest, files, dir) {
  const missing = []
  const wrong = []

  for (const [index, chunk] of manifest.chunks.entries()) {
    const name = path.basename(files[index])
    let stat

    try {
      stat = await fs.stat(files[index])
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      missing.push(name)
      continue
    }

    if (!stat.isFile()) {
      wrong.push(`${name} is not a file.`)
    } else if (stat.size !== chunk.size) {
      wrong.push(`${name} has ${stat.size} bytes, the manifest records ${chunk.size} bytes.`)
    }
  }

  if (missing.length === 0 && wrong.length === 0) return

  const lines = [`Cannot join ${manifest.id}:`]

  if (missing.length > 0) {
    lines.push(`${missing.length} of ${manifest.chunks.length} chunks are not in ${dir}:`)
    lines.push(...missing.map((name) => `  ${name}`))
  }

  lines.push(...wrong)
  lines.push(
    'Download them from the chat into that folder under exactly these names and run join ' +
      'again. A browser that saved a name twice may have added " (1)" to it.',
  )

  throw new Error(lines.join('\n'))
}

async function writeAll(handle, buffer, length, position) {
  let written = 0

  while (written < length) {
    const { bytesWritten } = await handle.write(buffer, written, length - written, position + written)
    written += bytesWritten
  }
}

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

// The offline half of restore: the chunks and the manifest were downloaded by hand, from
// Telegram web or anywhere else, and only the reassembly is left. Nothing here talks to
// the network, so nothing here needs a login or a message id — but every guarantee restore
// makes about the bytes still holds, because the manifest is what makes them, not the chat.
export async function runJoin(manifestPath, options = {}, deps = {}) {
  const {
    confirm = askConfirm,
    cwd = process.cwd(),
    writeErr = (line) => process.stderr.write(line),
    log: writeLog = (line) => console.log(line),
    silent = false,
    onTempChunk = () => {},
    askPassword = realAskPassword,
    interactive = () => Boolean(process.stdin.isTTY),
  } = deps

  const log = silent ? () => {} : writeLog
  const warn = silent ? () => {} : writeErr

  const manifest = await readManifest(manifestPath)
  assertPlainId(manifest.id)

  const dir = path.dirname(path.resolve(cwd, manifestPath))
  const files = manifest.chunks.map((chunk) => path.join(dir, chunkFileName(manifest.id, chunk.i)))

  await checkChunkFiles(manifest, files, dir)

  // After the files are known to be there — that costs nothing and needs no password — and
  // before the overwrite question, for restore's reason: nobody should answer [y/N] about a
  // file telstore then cannot decrypt.
  const opened = isEncrypted(manifest)
    ? await unlockManifest(manifest, { askPassword, interactive, say: log })
    : null

  const target = path.resolve(cwd, options.out ?? safeOutName(manifest.name))

  // Not `.partial`: that name belongs to restore, which resumes from it, and a join aimed at
  // the same file would otherwise truncate hours of somebody's download without asking.
  const joining = `${target}.joining`

  // Only ENOENT means "no file yet". Treating a permission or I/O error as absence would have
  // telstore overwrite the user's file without asking.
  let exists = true
  try {
    await fs.stat(target)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    exists = false
  }

  if (exists && !(await confirm(`${target} already exists. Overwrite? [y/N] `))) {
    throw new Error('Cancelled on request.')
  }

  log(`Backup ${manifest.id}`)
  if (opened) log('Lock   encrypted')
  log(`File   ${target} (${formatBytes(manifest.size)}, ${manifest.chunks.length} chunks)`)
  log(`From   ${dir}\n`)

  // Said before the open, so a Ctrl-C that lands between the two still has the name to remove.
  onTempChunk(joining)

  let handle = null

  try {
    handle = await fs.open(joining, 'w')

    const buffer = Buffer.allocUnsafe(COPY_SIZE)
    const count = manifest.chunks.length
    const progress = createProgress({ total: manifest.size, label: `Chunk 1/${count}`, write: warn })

    try {
      for (const [index, chunk] of manifest.chunks.entries()) {
        progress.setLabel(`Chunk ${chunk.i + 1}/${count}`)

        await copyChunk({
          file: files[index],
          handle,
          offset: chunk.i * manifest.chunkSize,
          chunk,
          count,
          buffer,
          advance: progress.advance,
          cipher: opened ? chunkCipher(opened.keys.chunkKey, chunk.iv) : null,
          plainSha256: opened ? opened.plainSha256[chunk.i] : null,
        })
      }
    } finally {
      progress.finish()
    }

    await handle.close()
    handle = null

    // Last line of defence, as in restore: every chunk matched and the file is still the
    // wrong length means the layout went wrong somewhere, and the rename must not happen.
    const written = await fs.stat(joining)

    if (written.size !== manifest.size) {
      throw new Error(
        `The joined file has ${written.size} bytes, the manifest records ${manifest.size} bytes — mismatch.`,
      )
    }

    await fs.rename(joining, target)
  } catch (err) {
    if (handle) await handle.close().catch(() => {})

    // Unlike restore's .partial there is nothing here worth keeping: the chunks are still on
    // disk, and a half-joined file is only somewhere a wrong file could be picked up from.
    try {
      await fs.rm(joining, { force: true })
    } catch (rmErr) {
      warn(`\nCould not remove ${joining} (${rmErr.message}). It is incomplete — remove it by hand.\n`)
    }

    throw err
  } finally {
    onTempChunk(null)
  }

  log(`\nDone. Wrote ${formatBytes(manifest.size)} to ${target}`)

  return { path: target, size: manifest.size }
}
