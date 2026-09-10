import { promises as fs } from 'node:fs'
import path from 'node:path'

import { Api } from 'teleproto'
import { CustomFile } from 'teleproto/client/uploads.js'

import { PART_SIZE, planChunks } from '../chunking.js'
import { chunkCaption, manifestCaption, parseNote } from '../caption.js'
import { describeChat } from '../chat.js'
import { closeQuietly, connect as realConnect } from '../client.js'
import { askConfirm } from '../confirm.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import { expandSources } from '../sources.js'
import { assertLoggedIn } from '../session.js'
import { requireChat, resolveSettings } from '../settings.js'
import {
  buildManifest,
  chunkFileName,
  manifestFileName,
  newBackupId,
  serializeManifest,
} from '../manifest.js'
import { createProgress, formatBytes, formatDuration } from '../progress.js'
import {
  MAX_STATES,
  clearState,
  loadState,
  markChunkDone,
  pruneStates,
  saveState,
  stateFile,
  stateKey,
} from '../state.js'
import { uploadRange } from '../uploader.js'

// Above this threshold the wait must be spelled out, per spec §8.
export const LONG_WAIT_MS = 60_000

// A transient error that resolves itself on the next try is not news, and one line per
// occurrence buries the progress bar in a wall of text. Stay quiet until the third retry:
// by then the trouble has outlived two backoffs and is worth saying out loud.
export const ANNOUNCE_AFTER_ATTEMPT = 3

// Retries and FLOOD_WAIT must be announced: a silent FLOOD_WAIT_3600 leaves the user
// staring at a frozen progress bar for an hour, assuming the process has hung.
//
// Exported because a stream upload waits on the same Telegram and has to say the same
// things about it. Two copies of this wording would drift, and the one that drifted would
// be the one nobody was reading at the time.
export function createOnRetry(warn) {
  return function onRetry(err, attempt, delayMs, elapsedMs = 0) {
    if (delayMs > LONG_WAIT_MS) {
      warn(
        `\nTelegram wants ${formatDuration(delayMs / 1000)} of waiting before the next send ` +
          `(${err.message}). telstore is waiting and will carry on by itself, leave it running.\n`,
      )
      return
    }

    // The exception to staying quiet: an attempt that took a minute to fail spent that
    // minute with the bar frozen, which is exactly what a hang looks like. Those are worth
    // a line the first time, whatever the attempt number.
    if (attempt < ANNOUNCE_AFTER_ATTEMPT && elapsedMs < LONG_WAIT_MS) return

    warn(
      `\nTemporary error (${err.message}), retry ${attempt} in ` +
        `${formatDuration(delayMs / 1000)}.\n`,
    )
  }
}

// Chunks and manifests differ only in where the bytes come from. Everything Telegram is
// told about them — document, not preview; this exact file name — is decided once.
async function sendDocument(client, peer, { file, fileName, caption }) {
  return await client.sendFile(peer, {
    file,
    caption,
    forceDocument: true,
    attributes: [new Api.DocumentAttributeFilename({ fileName })],
  })
}

// The defaults behind runUpload's `sendChunk` and `sendManifest` deps. Exported because a
// stream upload sends the same two kinds of document to the same Telegram, and a second copy
// of "document, not preview; this exact file name" is how the two start disagreeing about
// what telstore actually put in the chat.
export async function realSendChunk(client, peer, { inputFile, fileName, caption }) {
  return await sendDocument(client, peer, { file: inputFile, fileName, caption })
}

export async function realSendManifest(client, peer, { bytes, fileName, caption }) {
  return await sendDocument(client, peer, {
    file: new CustomFile(fileName, bytes.length, '', bytes),
    fileName,
    caption,
  })
}

// `--note quarterly accounts` is two arguments by the time node sees it: the note is
// "quarterly", and "accounts" is a file telstore has been asked to upload. Nothing here can
// put them back together — the shell dropped the quotes before the process started — so the
// one useful thing left is to name the mistake this probably was.
//
// Two things have to be true before it is said, and neither is enough alone. The note must
// still be one word — one that kept its spaces is one the shell was told to keep whole, so
// this cannot have happened to it — and a file must have been named *after* the flag, which
// is where an unquoted note's remaining words land. Without both, the file name is simply
// wrong, and sending someone off after a quoting bug that is not there costs them the typo
// waiting at the front of the same sentence.
function splitNoteHint(note, filesAfterNote) {
  if (!note || !filesAfterNote || /\s/.test(note)) return ''

  return (
    ` This run also carries --note ${JSON.stringify(note)}: a note with spaces in it has to be ` +
    'quoted, or the shell hands every word after the first to telstore as another file. ' +
    'Write it as --note "the whole note".'
  )
}

// What telstore will read the bytes from. A batch checks every path through this before it
// sends anything, so "File does not exist" reads the same whether it came from the one file
// asked for or from the fourth of six — one definition, one wording.
async function statSource(absPath, { note = null, filesAfterNote = false } = {}) {
  let stat

  try {
    stat = await fs.stat(absPath)
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`File does not exist: ${absPath}.${splitNoteHint(note, filesAfterNote)}`)
    }
    throw err
  }

  if (!stat.isFile()) {
    throw new Error(`${absPath} is not a file.`)
  }

  return stat
}

export async function runUpload(filePath, options = {}, deps = {}) {
  const {
    connect = realConnect,
    sendChunk = realSendChunk,
    sendManifest = realSendManifest,
    disconnect = (client) => client.destroy(),
    configDir = defaultConfigDir(),
    partSize = PART_SIZE,
    retryOptions = {},
    writeErr = (line) => process.stderr.write(line),
    log: writeLog = (line) => console.log(line),
    silent = false,
    onBackupId = () => {},
    // Where on the command line the note sat, as `route` saw it. Nothing else can know, and
    // a run that never says leaves the advice unsaid rather than guessed at.
    filesAfterNote = false,
  } = deps

  const absPath = path.resolve(filePath)

  // Before the file is even looked at: the note is the only thing this command sends that a
  // person typed by hand, and it is written into the manifest, which goes out last. A note
  // Telegram would refuse has to stop the run here, not after an hour of chunks whose only
  // list can no longer be sent.
  const note = parseNote(options.note)

  const stat = await statSource(absPath, { note, filesAfterNote })

  const config = await loadConfig(configDir)
  const { values: settings, source } = resolveSettings(options, config, {
    file: configFile(configDir),
  })
  const chat = requireChat(settings)
  const concurrency = settings.uploadConcurrency

  const key = stateKey(absPath, stat.size, stat.mtimeMs)

  let state = await loadState(key, configDir)

  // The chunks already in the chat were cut at the size this backup started with, and
  // nothing can re-cut them. Carrying on at a different size would abandon every one of
  // them in the chat, where telstore can no longer find them — so an unfinished backup
  // keeps its own chunk size, and a flag that disagrees is refused rather than obeyed.
  //
  // Only a flag is a disagreement. A configured chunkSize says what to use when nobody asks
  // for anything, and this run asked for nothing — so the backup quietly keeps its own size
  // rather than being refused over a preference set weeks ago for other files.
  if (state && source('chunkSize') === 'flag' && settings.chunkSize !== state.chunkSize) {
    const file = stateFile(key, configDir)
    throw new Error(
      `This unfinished backup is cut into ${formatBytes(state.chunkSize)} chunks, but ` +
        `--chunk-size asks for ${formatBytes(settings.chunkSize)} — the chunks already in ` +
        `${state.chat} cannot be re-cut. Run again without --chunk-size to carry on, or delete ` +
        `${file} and run again to start a new backup, which leaves the chunks already sent ` +
        'sitting in the chat with nothing to point at them.',
    )
  }

  const chunkSize = state ? state.chunkSize : settings.chunkSize

  // A resumed upload takes its chunk size off disk, and nothing validated that file on the
  // way in. planChunks will refuse an unusable one, but its message is about chunk sizes and
  // would send the reader looking for a --chunk-size flag they never passed.
  if (state && (!Number.isSafeInteger(chunkSize) || chunkSize < 1)) {
    throw new Error(
      `The record of this unfinished backup gives a chunk size of ${JSON.stringify(chunkSize)}, ` +
        `which cannot be used. ${stateFile(key, configDir)} is damaged — delete it and run ` +
        'again to start a new backup, which leaves the chunks already sent sitting in the ' +
        'chat with nothing to point at them.',
    )
  }

  const chunks = planChunks(stat.size, chunkSize)
  const resuming = Boolean(state)

  // Naming the way back rather than a flag to drop: the destination may have come from the
  // command line or from the stored setting, and "run again without --chat" is no help to
  // someone who never typed one. Pointing at the chat itself is right either way.
  if (resuming && state.chat !== String(chat)) {
    const file = stateFile(key, configDir)
    throw new Error(
      `This unfinished backup is going to ${state.chat}, but the current command targets ${chat} — ` +
        `a single backup cannot be split across two destinations. Run again with ` +
        `--chat ${state.chat} to carry on sending there, or delete ${file} and run again to ` +
        `start a new backup in ${chat}.`,
    )
  }

  if (!resuming) {
    state = {
      id: newBackupId(),
      chat: String(chat),
      path: absPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      chunkSize,
      done: {},
    }
    await saveState(key, state, configDir)

    // Only a new backup adds to the directory, so this is the one place it can grow.
    // The report goes out even when the caller asked for silence: this is not narration
    // about a transfer, it is telstore dropping the only record of someone else's chunks.
    for (const gone of await pruneStates(configDir)) {
      writeErr(
        `\nDropped the record of unfinished backup ${gone.id}: telstore keeps the ` +
          `${MAX_STATES} most recent. The chunks it sent are still in ${gone.chat}, ` +
          'searchable by that id, but that backup can no longer be resumed.\n',
      )
    }
  }

  onBackupId(state.id)

  const log = silent ? () => {} : writeLog
  const warn = silent ? () => {} : writeErr

  const onRetry = createOnRetry(warn)

  log(`Backup ${state.id}`)
  log(`File   ${absPath} (${formatBytes(stat.size)}, ${chunks.length} chunks)`)
  log(`To     ${describeChat(chat)}\n`)

  const client = await connect(config, { verbose: settings.verbose })

  try {
    // Everything already in the chat is reported before the bar exists. These lines go to
    // stdout while the bar is rewritten on stderr with \r, so printed from inside the loop
    // they would land straight on the line the bar keeps returning to.
    const pending = []

    for (const chunk of chunks) {
      if (state.done[String(chunk.i)]) {
        log(`Chunk ${chunk.i + 1}/${chunks.length} already uploaded, skipping.`)
        continue
      }

      pending.push(chunk)
    }

    // A run that only failed to send the manifest has every chunk done and nothing left to
    // transfer: no bar at all, rather than one that springs into existence at 100%.
    if (pending.length > 0) {
      const remaining = pending.reduce((sum, chunk) => sum + chunk.length, 0)

      // One bar for the whole upload: the label names the chunk in flight, everything else
      // describes the file. Chunks a previous run sent count towards the bar but not towards
      // the speed, so an hour-old chunk cannot inflate the ETA of the ones still to go.
      // warn is already the no-op when silent, and createProgress draws through nothing else.
      const progress = createProgress({
        total: stat.size,
        done: stat.size - remaining,
        label: `Chunk ${pending[0].i + 1}/${chunks.length}`,
        write: warn,
      })

      try {
        for (const chunk of pending) {
          progress.setLabel(`Chunk ${chunk.i + 1}/${chunks.length}`)

          const fileName = chunkFileName(state.id, chunk.i)
          const handle = await fs.open(absPath, 'r')

          try {
            const { inputFile, sha256 } = await uploadRange(client, handle.fd, {
              offset: chunk.offset,
              length: chunk.length,
              fileName,
              concurrency,
              partSize,
              onProgress: (bytes) => progress.advance(bytes),
              retryOptions: { ...retryOptions, onRetry },
            })

            const message = await sendChunk(client, chat, {
              inputFile,
              fileName,
              caption: chunkCaption({ id: state.id, number: chunk.i + 1, total: chunks.length }),
            })

            state = await markChunkDone(
              key,
              state,
              chunk.i,
              { msgId: message.id, size: chunk.length, sha256 },
              configDir,
            )
          } finally {
            await handle.close()
          }
        }
      } finally {
        // Same reason as restore: a send that fails must not leave "Error: ..." printed over
        // the bar's own line.
        progress.finish()
      }
    }

    // The file can be overwritten mid-upload — with a 50GB file an hour passes between
    // the first and last chunk. The manifest would then describe a hybrid file that never
    // existed: restore still matches every sha256, but the data is garbage.
    const after = await fs.stat(absPath)

    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw new Error(
        `${absPath} changed during the upload ` +
          `(size ${stat.size} → ${after.size}, mtime ${stat.mtimeMs} → ${after.mtimeMs}). ` +
          'This backup mixes old and new data and cannot be trusted — telstore is not sending the manifest. ' +
          'Wait until the file settles, then run again to create a new backup.',
      )
    }

    const manifest = buildManifest({
      id: state.id,
      name: path.basename(absPath),
      size: stat.size,
      chunkSize,
      note,
      chunks: chunks.map((chunk) => ({ i: chunk.i, ...state.done[String(chunk.i)] })),
    })

    await sendManifest(client, chat, {
      bytes: serializeManifest(manifest),
      fileName: manifestFileName(state.id),
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

    log(`\nDone. Restore with:\n  npx telstore restore ${state.id}`)

    return { id: state.id, chunks: chunks.length }
  } finally {
    await closeQuietly(client, disconnect, (err) =>
      warn(`\nWarning: could not close the Telegram connection: ${err.message}\n`),
    )
  }
}

// `telstore a b c` is three backups, not one: each file keeps its own id, its own manifest and
// its own resumable record, so a batch is exactly what running the command three times would
// have produced — minus two logins. The connection is the one thing worth sharing, and it is
// shared through the same deps seam the tests drive, so runUpload stays the only caller of
// connect and nothing here has to know what a client is.
export async function runUploads(filePaths, options = {}, deps = {}) {
  const {
    connect = realConnect,
    disconnect = (client) => client.destroy(),
    configDir = defaultConfigDir(),
    writeErr = (line) => process.stderr.write(line),
    log: writeLog = (line) => console.log(line),
    silent = false,
    onFileDone = () => {},
    confirm = askConfirm,
    interactive = () => Boolean(process.stdin.isTTY),
    filesAfterNote = false,
  } = deps

  const log = silent ? () => {} : writeLog
  const warn = silent ? () => {} : writeErr

  // One note covers the whole run, so a note telstore cannot send is one mistake, not one per
  // file. Left to runUpload it would be caught per file and swallowed into the summary as a
  // failed row, after the files ahead of it had already gone out labelled with nothing.
  const note = parseNote(options.note)

  // What was typed and what will be sent are two different lists once a folder or a pattern is
  // allowed: resolve them here, before anything else has an opinion about them.
  const { paths: found, skipped } = await expandSources(filePaths)
  const paths = found.map((filePath) => path.resolve(filePath))

  // Something inside a named folder that is not going to be uploaded is still something the
  // user pointed at, so it is said out loud rather than quietly missing from the list.
  const folders = skipped.filter((entry) => entry.reason === 'directory')

  if (folders.length > 0) {
    warn(
      `\ntelstore reads one level down, so these folders were left alone: ` +
        `${folders.map((entry) => path.basename(entry.path)).join(', ')}. ` +
        'Name one of them to upload what is inside it.\n',
    )
  }

  for (const entry of skipped) {
    if (entry.reason !== 'directory') warn(`\n${entry.path} was skipped: ${entry.reason}.\n`)
  }

  // A single file is the common case and must read exactly as it did before this existed:
  // no batch heading, no question, no summary, and an error that reaches the caller rather
  // than a report.
  if (paths.length === 1) {
    const { id, chunks } = await runUpload(paths[0], options, deps)
    return { results: [{ path: paths[0], id, chunks }], failed: 0 }
  }

  // Everything that can be known before the first byte goes out is settled here. A typo in the
  // fourth name must not surface an hour into the third file, and a destination nobody set is
  // one problem, not one per file — the report at the end is for what only the transfer can
  // discover.
  const duplicate = paths.find((absPath, index) => paths.indexOf(absPath) !== index)

  if (duplicate) {
    throw new Error(
      `${duplicate} is named twice — a folder or a pattern can pick up a file that was ` +
        'named on its own as well. Uploading one file twice would make two backups of the ' +
        'same bytes, each with its own id: name it once, or run telstore again afterwards if ' +
        'a second copy is really what you want.',
    )
  }

  const config = await loadConfig(configDir)

  // The login is checked here rather than left to the first connect: reported from inside the
  // loop it would arrive once per file, each one having already written a state record for a
  // backup that never sent a byte.
  assertLoggedIn(config)

  const { values: settings } = resolveSettings(options, config, { file: configFile(configDir) })
  const chat = requireChat(settings)

  const sizes = []

  for (const absPath of paths) sizes.push((await statSource(absPath, { note, filesAfterNote })).size)

  // The last thing before the first byte. A folder or a pattern hands telstore a list nobody
  // has read yet, and even a hand-typed one is worth seeing added up: this is the moment where
  // "23 files, 180 GB, to @family_photos" is still a question rather than an afternoon.
  if (!options.yes) {
    if (!interactive()) {
      throw new Error(
        `${paths.length} files to upload, and no terminal to confirm that in. Run again with ` +
          '--yes to upload them without being asked.',
      )
    }

    for (const line of listingLines(paths, sizes, chat)) log(line)

    if (!(await confirm(`Upload these ${paths.length} files? [y/N] `))) {
      throw new Error('Cancelled on request.')
    }
  }

  let shared = null
  const perFile = {
    ...deps,
    connect: async (theirConfig, connectOptions) =>
      (shared ??= await connect(theirConfig, connectOptions)),
    disconnect: async () => {},
  }

  const results = []

  try {
    for (const [index, absPath] of paths.entries()) {
      if (index > 0) log('')
      log(`[${index + 1}/${paths.length}] ${path.basename(absPath)}`)

      let result
      try {
        const { id, chunks } = await runUpload(absPath, options, perFile)
        result = { path: absPath, id, chunks }
      } catch (err) {
        // One file's trouble is that file's trouble. Stopping here would leave the files
        // named after it untouched and unmentioned, which is the batch equivalent of the
        // silent drop this command exists to end — so it is recorded and named in the
        // summary, and the exit code carries it out to the shell.
        //
        // It is also said out loud here and now. Waiting for the summary would leave the bar
        // of the next file scrolling for an hour over a failure nobody had been told about.
        result = { path: absPath, error: err.message }
        warn(`\n${path.basename(absPath)} failed: ${err.message}\n`)
      }

      results.push(result)
      onFileDone(result)
    }
  } finally {
    if (shared) {
      await closeQuietly(shared, disconnect, (err) =>
        warn(`\nWarning: could not close the Telegram connection: ${err.message}\n`),
      )
    }
  }

  const failed = results.filter((result) => result.error).length

  log('')
  for (const line of summaryLines(results, failed)) log(line)

  return { results, failed }
}

// What the batch is about to do, in the shape the summary will report it afterwards: the same
// names, the same order, so the two lists can be read against each other.
function listingLines(paths, sizes, chat) {
  const names = paths.map((absPath) => path.basename(absPath))
  const amounts = sizes.map(formatBytes)
  const width = Math.max(...names.map((name) => name.length))
  const amountWidth = Math.max(...amounts.map((amount) => amount.length))
  const total = sizes.reduce((sum, size) => sum + size, 0)

  return [
    `${paths.length} files, ${formatBytes(total)}, to ${describeChat(chat)}`,
    '',
    ...names.map((name, i) => `  ${name.padEnd(width)}  ${amounts[i].padStart(amountWidth)}`),
    '',
  ]
}

// The one place a batch says how it went. Every file gets a line whether it worked or not:
// a name missing from this list would be a file nobody could tell the fate of.
function summaryLines(results, failed) {
  const width = Math.max(...results.map((result) => path.basename(result.path).length))
  const uploaded = results.length - failed
  const lines = [`${results.length} files: ${uploaded} uploaded, ${failed} failed.`, '']

  for (const result of results) {
    const name = path.basename(result.path).padEnd(width)

    if (result.error) {
      lines.push(`  ${name}  failed: ${result.error}`)
      continue
    }

    lines.push(`  ${name}  ${result.id}  (${result.chunks} chunk${result.chunks === 1 ? '' : 's'})`)
  }

  if (uploaded > 0) {
    lines.push('', 'Restore with: npx telstore restore <backup-id>')
  }

  return lines
}
