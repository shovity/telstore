import { promises as fs } from 'node:fs'
import path from 'node:path'

import { MAX_CHUNKS, PART_SIZE } from '../chunking.js'
import { chunkCaption, manifestCaption, parseNote } from '../caption.js'
import { chatName, describeChat } from '../chat.js'
import {
  MESSAGE_BATCH_SIZE,
  closeQuietly,
  connect as realConnect,
  deleteMessages as realDeleteMessages,
} from '../client.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import {
  buildManifest,
  chunkFileName,
  manifestFileName,
  newBackupId,
  serializeManifest,
} from '../manifest.js'
import { createStreamProgress, formatBytes, plural } from '../progress.js'
import { requireChat, resolveSettings } from '../settings.js'
import { shellArg } from '../shell.js'
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
//
// On writeErr rather than warn, like the prune report and for the same reason: a leaked file
// holding up to 1.8GB is not narration about a transfer that --silent asked to be spared. It
// is telstore leaving something on this machine that only the user can now clear up, and a
// caller silencing the progress bar has not asked to be kept in the dark about that.
async function discard(handle, file, { writeErr, chunkSize }) {
  try {
    await handle.close()
  } catch {
    // The file is about to be unlinked; whatever close had to say about it changes nothing.
  }

  try {
    await fs.rm(file, { force: true })
  } catch (err) {
    writeErr(
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
    deleteMessages = realDeleteMessages,
    retryOptions = {},
    writeErr = (line) => process.stderr.write(line),
    log: writeLog = (line) => console.log(line),
    silent = false,
    onBackupId = () => {},
    // How Ctrl-C reaches a run that must not be killed where it stands. See the call below.
    onAbortable = () => {},
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

  // The producer and the reader are named here rather than where they are made, because the
  // abort below has to be handed out before either exists.
  let aborted = false
  let child = null
  let reader = null

  // A run whose chunks are removed when it fails cannot be killed where it stands: exiting at
  // the signal would leave in the chat exactly the chunks this command promises never to
  // leave, and removing them is a network round trip per batch. So Ctrl-C asks the run to
  // stop instead, through this, and waits for the rollback below to finish.
  //
  // Handed over before connect, not after the child is spawned: from the moment the record
  // exists there is something a Ctrl-C has to unwind, and a caller that has not been given
  // this yet has no choice but to exit on the spot.
  onAbortable(async () => {
    aborted = true

    // The kill stops the producer; closing the reader is what unblocks a fill still waiting
    // on a pipe the child is never going to write to again.
    if (child) child.kill()
    if (reader) await reader.close()
  }, { chat })

  // The one error the caller is meant to recognise: a run that stopped because someone asked
  // it to has nothing to report that Ctrl-C did not already say. A rollback that could not
  // finish throws a fresh error of its own instead, and that one is still a failure.
  function stopped() {
    const err = new Error('Stopped before the backup was finished.')
    err.interrupted = true
    return err
  }

  const log = silent ? () => {} : writeLog
  const warn = silent ? () => {} : writeErr
  const onRetry = createOnRetry(warn)

  // Every message id this run has put in the chat, in the order it put them there. The record
  // on disk is the durable copy, for the run that dies without getting this far; this one is
  // what rollback reaches for, because it is right even when the write to disk is the thing
  // that failed.
  const sent = []
  let client = null

  // A file upload keeps its chunks on purpose — a second run resumes onto them. A stream
  // cannot be resumed: the bytes have gone past, and the next run cuts them differently. So a
  // chunk left in the chat by a failed stream is a chunk nothing will ever point at again,
  // sitting in somebody's Telegram with no manifest naming it. Removing them is part of
  // failing, not a courtesy. Always throws.
  async function rollback(err) {
    if (sent.length === 0) {
      // Cleared even when it names nothing. An empty record is useless, but it still counts
      // against MAX_STATES exactly as a full one does — so leaving it behind can evict the
      // record of a real upload whose chunks are still in a chat, which is the loss
      // pruneStates goes out of its way to announce.
      await clearState(key, configDir)
      throw err
    }

    // "message" rather than "chunk": the manifest joins this list on the narrow path where a
    // run fails after sending it, and a count that says "3 chunks" for two chunks and a card
    // is telstore describing the chat wrongly in the one report someone reads closely.
    warn(`\nRemoving the ${plural(sent.length, 'message')} this run already sent...\n`)

    const loud = sent.length > MESSAGE_BATCH_SIZE
    let removed = 0

    try {
      await deleteMessages(client, chat, sent, {
        retryOptions: { ...retryOptions, onRetry },
        onBatch: (done, total) => {
          removed = done
          if (loud) warn(`\rRemoving messages ${done}/${total}…`)
        },
      })
    } catch (cleanupErr) {
      // The record stays, and deliberately: it is the only list of these message ids, since
      // there is no manifest in the chat and there never will be one. `delete` reads exactly
      // this record through findStates when it finds no manifest, which is why that is the
      // command to name. The original failure is still said first — the rollback is what
      // happened next, not what went wrong.
      //
      // The chat is always named, where `status` leaves --chat out when it matches the
      // destination in force. status compares against the destination its own run resolved,
      // which is the one the pasted command will resolve too. Here the destination in force
      // may have come from a --chat on this command line, which the later `delete` will not
      // carry: it would resolve its own chat from config and fire these ids at that peer
      // instead, destroying whatever happens to carry them there. Naming a chat that turns
      // out to be the default costs a few characters; leaving it out when it is not costs
      // somebody else's messages, and nothing undoes that.
      throw new Error(
        `${err.message}\n\ntelstore then removed ${removed} of the ` +
          `${plural(sent.length, 'message')} it had sent before Telegram refused: ` +
          `${cleanupErr.message}. The rest are still in ${chatName(chat)}. The local record ` +
          'was left in place on purpose — it is the only list of them on this machine. Run ' +
          `"npx telstore delete ${shellArg(id)} --chat ${shellArg(chat)}" to remove them.`,
      )
    }

    if (loud) warn('\n')

    await clearState(key, configDir)

    throw err
  }

  log(`Backup ${id}`)
  log(`Name   ${name} (chunks of ${formatBytes(chunkSize)})`)
  log(`From   ${childArgv.join(' ')}`)
  log(`To     ${describeChat(chat)}\n`)

  try {
    client = await connect(config, { verbose: settings.verbose })

    // Connecting is the one stretch long enough for Ctrl-C to arrive before the command has
    // been started, and starting someone's command after they asked telstore to stop is the
    // one thing a wait must not turn into.
    if (aborted) throw stopped()

    const tmp = tempDirFor(configDir)
    await fs.mkdir(tmp, { recursive: true })

    child = spawn(childArgv)
    reader = new ChunkReader(child.stdout)

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

            // An abort that lands while this fill was waiting must not become one more chunk
            // in the chat. The rollback below would remove it again, but not before minutes
            // of uploading had gone by with the bar still moving, in front of the person who
            // asked telstore to stop.
            if (aborted) throw stopped()

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

              // Before the record is written, not after: a chunk is in the chat the instant
              // sendChunk returns, and a saveState that throws must not be what hides it
              // from the rollback that is about to run.
              sent.push(message.id)

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
            await discard(handle, file, { writeErr, chunkSize })
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

      const card = await sendManifest(client, chat, {
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

      // The manifest is a message this run put in the chat like any other. Anything that
      // fails after this line — the record write below, the closing line written into a pipe
      // that has gone away — still rolls back, and a rollback that took the chunks but left
      // this would leave a backup `list` advertises and `restore` cannot fulfil. Pushed last
      // so it is removed last, the order `delete` keeps for the same reason: the manifest is
      // the only index of the ids under it, so it is the one thing worth having if a removal
      // stops halfway.
      sent.push(card.id)

      // And into the record, before that record can be left behind by a rollback that could
      // not finish. `sent` is this process's memory and dies with it; the record is what
      // `delete` reads afterwards, and the only other way it could find this card is
      // `findManifestMessage`, which asks Telegram's text index — docs/design/captions.md
      // records that index returning nothing for a channel whose documents were all plainly
      // there, and nothing predicts when it happens. A delete that cannot find the manifest
      // takes the chunks and leaves the card behind advertising a backup restore cannot
      // fulfil. Written after the push, for the same reason the chunk ids are: a saveState
      // that throws must not be what hides this message from the rollback about to run.
      state = { ...state, manifestMsgId: card.id }
      await saveState(key, state, configDir)

      log(`\nDone. Restore with:\n  npx telstore restore ${id}`)

      // Cleared after the closing line rather than before it, which is what gives the write
      // above anything to protect. Writing that line is a real thing that fails — `telstore …
      // | head` closes the pipe under telstore's feet — and it rolls the run back. A record
      // cleared a moment earlier would leave a rollback that Telegram then refuses with the
      // chunks and the card still in the chat and nothing on this machine naming any of them.
      await clearState(key, configDir)

      return { id, chunks: count, size }
    } finally {
      // A run that fell over mid-chunk leaves the producer alive and blocked writing into a
      // pipe nobody is reading. Killing it is not rollback — it is closing the door this
      // function opened, and the door is more than the process: the abandoned iterator still
      // holds stdout, so a child that outlives the signal goes on waiting on a pipe whose
      // reader is never coming back. Returning the iterator releases it and destroys the
      // stream, which turns that wait into an EPIPE the child can actually act on.
      if (!ended) {
        child.kill()
        await reader.close()
      }
    }
  } catch (err) {
    // Whatever an abort surfaced as — a fill rejecting on a destroyed pipe, a producer that
    // died on the signal, a stall that never came back — the reason this run stopped is the
    // Ctrl-C, and saying so is what lets the caller leave with 130 instead of reporting a
    // failure nobody had.
    //
    // Always throws: the error itself once the chat is clean again, or a report of the
    // rollback that could not finish.
    await rollback(aborted ? stopped() : err)
  } finally {
    // connect is inside the try now, because a rollback needs a live client and the finally
    // that closes one has to run after it. So a connect that failed leaves nothing to close,
    // and a warning about closing a client that never existed would bury the real reason the
    // run stopped.
    if (client) {
      await closeQuietly(client, disconnect, (err) =>
        warn(`\nWarning: could not close the Telegram connection: ${err.message}\n`),
      )
    }
  }
}
