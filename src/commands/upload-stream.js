import { promises as fs } from 'node:fs'
import path from 'node:path'

import { MAX_CHUNKS, PART_SIZE } from '../chunking.js'
import { chunkCaption, manifestCaption, parseNote } from '../caption.js'
import { describeChat } from '../chat.js'
import { closeQuietly, connect as realConnect } from '../client.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import {
  buildManifest,
  chunkFileName,
  manifestFileName,
  newBackupId,
  serializeManifest,
} from '../manifest.js'
import { createStreamProgress, formatBytes } from '../progress.js'
import { requireChat, resolveSettings } from '../settings.js'
import { spawnProducer } from '../spawn.js'
import {
  MAX_STATES,
  clearState,
  markChunkDone,
  pruneStates,
  saveState,
  streamKey,
} from '../state.js'
import { ChunkReader } from '../stream.js'
import { uploadRange } from '../uploader.js'
import { createOnRetry, realSendChunk, realSendManifest } from './upload.js'

// One chunk of borrowed disk at a time, under ~/.telstore rather than os.tmpdir(): /tmp is
// tmpfs on many Linux distributions, and "borrow one chunk of disk" would silently mean
// "borrow 1800MB of RAM" — a memory limit dressed up as a chunk size.
export function tempDirFor(configDir) {
  return path.join(configDir, 'tmp')
}

// The borrowing ends whether the chunk went out or the run fell over on it. close() failing
// must not be what stops the unlink — the file would sit there holding a whole chunk that
// nothing will ever remove — and a removal that fails must not replace the error already on
// its way out of the loop, so it is said on stderr rather than thrown.
async function discard(handle, file, { warn, chunkSize }) {
  try {
    await handle.close()
  } catch {
    // The file is about to be unlinked; whatever close had to say about it changes nothing.
  }

  try {
    await fs.rm(file, { force: true })
  } catch (err) {
    warn(
      `\nCould not remove the temporary chunk file ${file}: ${err.message}. It holds up to ` +
        `${formatBytes(chunkSize)} and telstore will not try again — remove it by hand.\n`,
    )
  }
}

// `telstore a.tar -- tar cf ./a`: the backup's bytes are what the command writes, and the
// name is a label, not a file telstore reads.
//
// This is runUpload with the one thing it leans on taken away — a length known up front — so
// there is no planChunks, no resume, no re-stat, and no total on the bar. What replaces the
// re-stat is the child's exit code, which is the whole reason telstore spawns the command
// instead of reading a pipe.
export async function runStreamUpload(name, childArgv, options = {}, deps = {}) {
  const {
    connect = realConnect,
    sendChunk = realSendChunk,
    sendManifest = realSendManifest,
    disconnect = (client) => client.destroy(),
    configDir = defaultConfigDir(),
    partSize = PART_SIZE,
    // Through deps rather than read straight off the constant: this branch only fires after
    // ten thousand chunks have gone out, and a limit a test cannot lower is a limit no test
    // will ever reach.
    maxChunks = MAX_CHUNKS,
    spawn = spawnProducer,
    retryOptions = {},
    writeErr = (line) => process.stderr.write(line),
    log: writeLog = (line) => console.log(line),
    silent = false,
    onBackupId = () => {},
  } = deps

  // Before the command is started, let alone connected to Telegram: the note is the one thing
  // this run sends that a person typed by hand, and it goes into the manifest, which goes out
  // last. A note Telegram would refuse has to stop the run here, not after an hour of pg_dump.
  const note = parseNote(options.note)

  const config = await loadConfig(configDir)
  const { values: settings } = resolveSettings(options, config, { file: configFile(configDir) })
  const chat = requireChat(settings)
  const chunkSize = settings.chunkSize
  const concurrency = settings.uploadConcurrency

  const id = newBackupId()
  const key = streamKey(id)

  // A stream record exists for one reason: to say what is already in the chat when the run
  // fails, because nothing else will ever point at those chunks. There is no path, size or
  // mtime to key it on and nothing to resume onto — `kind` is what tells status and delete so.
  let state = { v: 1, kind: 'stream', id, chat: String(chat), name, chunkSize, done: {} }

  await saveState(key, state, configDir)

  // Every stream upload adds to the directory, so this is where it can grow. The report goes
  // out even when the caller asked for silence: this is not narration about a transfer, it is
  // telstore dropping the only record of someone else's chunks.
  for (const gone of await pruneStates(configDir)) {
    writeErr(
      `\nDropped the record of unfinished backup ${gone.id}: telstore keeps the ` +
        `${MAX_STATES} most recent. The chunks it sent are still in ${gone.chat}, ` +
        'searchable by that id, but that backup can no longer be resumed.\n',
    )
  }

  onBackupId(id)

  const log = silent ? () => {} : writeLog
  const warn = silent ? () => {} : writeErr
  const onRetry = createOnRetry(warn)

  log(`Backup ${id}`)
  log(`Name   ${name} (chunks of ${formatBytes(chunkSize)})`)
  log(`From   ${childArgv.join(' ')}`)
  log(`To     ${describeChat(chat)}\n`)

  const client = await connect(config, { verbose: settings.verbose })

  try {
    const tmp = tempDirFor(configDir)
    await fs.mkdir(tmp, { recursive: true })

    const child = spawn(childArgv)
    const reader = new ChunkReader(child.stdout)

    let size = 0
    let count = 0
    let ended = false
    let progress = null

    try {
      try {
        for (;;) {
          const file = path.join(tmp, `${id}-${count}.chunk`)
          const handle = await fs.open(file, 'w+')
          let eof = false

          try {
            // Nothing pulls ahead of this call, which is what stops the child running away
            // with the pipe while a chunk spends three minutes uploading: the backlog waits
            // in the kernel's buffer and in the child, not in this process's memory.
            const filled = await reader.fill(handle, chunkSize)
            eof = filled.eof

            if (filled.bytes > 0) {
              // Asked of bytes that actually arrived, not of the count alone. A stream that
              // ends exactly on a chunk boundary reports eof only on the fill after it, so a
              // check before the fill would refuse a backup of exactly maxChunks chunks —
              // one the file path builds happily.
              //
              // Checked here rather than before the first byte because there is no length to
              // count chunks from, and a stream cannot be re-cut: the way out is a bigger
              // chunk on the next run, not a resume of this one.
              if (count >= maxChunks) {
                throw new Error(
                  `This command has already produced ${maxChunks} chunks of ` +
                    `${formatBytes(chunkSize)} and has not finished, which is as many as a ` +
                    'backup holds. Run again with a larger --chunk-size.',
                )
              }

              const fileName = chunkFileName(id, count)

              // No bar until there is something to draw one for. A command that writes
              // nothing would otherwise get a bar springing into existence at zero, only to
              // be told a moment later that there is no backup to make.
              if (progress === null) {
                progress = createStreamProgress({ label: `Chunk ${count + 1}`, write: warn })
              } else {
                progress.setLabel(`Chunk ${count + 1}`)
              }

              // Offset 0 of a file holding exactly this chunk: uploadRange neither knows nor
              // cares that the bytes arrived through a pipe rather than off a disk.
              const { inputFile, sha256 } = await uploadRange(client, handle.fd, {
                offset: 0,
                length: filled.bytes,
                fileName,
                concurrency,
                partSize,
                onProgress: (bytes) => progress.advance(bytes),
                retryOptions: { ...retryOptions, onRetry },
              })

              const message = await sendChunk(client, chat, {
                inputFile,
                fileName,
                // A stream knows the number and not the count. The manifest card carries the
                // total once there finally is one.
                caption: chunkCaption({ id, number: count + 1, total: null }),
              })

              // Recorded the moment it lands, because from here on this record is the only
              // list of what is in the chat under this id.
              state = await markChunkDone(
                key,
                state,
                count,
                { msgId: message.id, size: filled.bytes, sha256 },
                configDir,
              )

              size += filled.bytes
              count += 1
            }
          } finally {
            await discard(handle, file, { warn, chunkSize })
          }

          if (eof) break
        }
      } finally {
        // Same reason as runUpload: a send that fails must not leave "Error: ..." printed
        // over the bar's own line.
        progress?.finish()
      }

      // The stream's answer to the file path's re-stat, and the reason telstore spawns the
      // command rather than reading a pipe. An EOF after a crash and an EOF after success are
      // the same event on this end of the pipe; the exit code is the only thing that tells
      // them apart, and a manifest sent without it would describe a truncated archive that
      // restores perfectly and is garbage.
      const { code, signal } = await child.exited
      ended = true

      if (code !== 0 || signal !== null) {
        throw new Error(
          signal !== null
            ? `${childArgv[0]} was killed by ${signal} after writing ${formatBytes(size)}. ` +
              'telstore is not sending the manifest: what it wrote is an unfinished file.'
            : `${childArgv[0]} exited ${code} after writing ${formatBytes(size)}. ` +
              'telstore is not sending the manifest: what it wrote is an unfinished file.',
        )
      }

      // A clean exit having written nothing is usually a command whose arguments were wrong,
      // and a backup of nothing is not a backup — restore would have nothing to write.
      if (size === 0) {
        throw new Error(`${childArgv[0]} wrote nothing, so there is no backup to make.`)
      }

      const manifest = buildManifest({
        id,
        name,
        size,
        chunkSize,
        note,
        chunks: Array.from({ length: count }, (_, i) => ({ i, ...state.done[String(i)] })),
      })

      await sendManifest(client, chat, {
        bytes: serializeManifest(manifest),
        fileName: manifestFileName(id),
        caption: manifestCaption({
          id: manifest.id,
          name: manifest.name,
          size: manifest.size,
          chunks: manifest.chunks.length,
          createdAt: manifest.createdAt,
          note: manifest.note ?? null,
        }),
      })

      await clearState(key, configDir)

      log(`\nDone. Restore with:\n  npx telstore restore ${id}`)

      return { id, chunks: count, size }
    } finally {
      // A run that fell over mid-chunk leaves the producer alive and blocked writing into a
      // pipe nobody is reading. Killing it is not rollback — it is closing the door this
      // function opened.
      if (!ended) child.kill()
    }
  } finally {
    await closeQuietly(client, disconnect, (err) =>
      warn(`\nWarning: could not close the Telegram connection: ${err.message}\n`),
    )
  }
}
