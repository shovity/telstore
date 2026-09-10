import { promises as fs } from 'node:fs'
import path from 'node:path'

import { describeChat } from '../chat.js'
import {
  closeQuietly,
  connect as realConnect,
  findManifestMessage,
  readMessageBytes as realReadMessageBytes,
} from '../client.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import { parseManifest } from '../manifest.js'
import { createProgress, formatBytes, plural } from '../progress.js'
import { assertLoggedIn } from '../session.js'
import { requireChat, resolveSettings } from '../settings.js'
import { spawnProducer } from '../spawn.js'
import { tempDirFor } from '../state.js'
import { discardChunkFile, writeChunkTo } from '../stream.js'
import { isGzipName } from '../tar.js'
import { createOnRetry, realDownloadChunk, realGetMessage } from './restore.js'

// `telstore restore <id> -- tar xzf -`: the backup's bytes go to a command's stdin instead of
// into a file.
//
// This is runRestore with the file taken away, and the file was carrying more than the bytes:
// no .partial, no resume record, no scan of what an earlier run left, no rename, and no stat
// at the end to compare against the manifest. What replaces all of it is the order of two
// things — verify the chunk, then hand it over — and the command's exit code.
export async function runRestoreStream(backupId, childArgv, options = {}, deps = {}) {
  const {
    connect = realConnect,
    disconnect = (client) => client.destroy(),
    configDir = defaultConfigDir(),
    searchManifest = findManifestMessage,
    readMessageBytes = realReadMessageBytes,
    getMessage = realGetMessage,
    downloadChunk = realDownloadChunk,
    spawn = spawnProducer,
    retryOptions = {},
    writeErr = (line) => process.stderr.write(line),
    log: writeLog = (line) => console.log(line),
    silent = false,
    onBackupId = () => {},
    onTempChunk = () => {},
    // How a Ctrl-C that will not wait still stops the command. Unlike the upload direction
    // there is nothing in the chat to unwind, so this run does not ask to be waited for — but
    // leaving without stopping tar lets it go on writing files after telstore is gone.
    onChild = () => {},
    // tarx only. The alias promises gzip, so it checks the claim before spending a gigabyte
    // finding out; `restore <id> -- tar xf -` promises nothing and is asked nothing.
    requireGzipName = false,
  } = deps

  const config = await loadConfig(configDir)

  assertLoggedIn(config)

  const { values: settings } = resolveSettings(options, config, { file: configFile(configDir) })
  const chat = requireChat(settings)
  const log = silent ? () => {} : writeLog
  const warn = silent ? () => {} : writeErr
  const onRetry = createOnRetry(warn)

  onBackupId(backupId)

  const client = await connect(config, { verbose: settings.verbose })
  let child = null
  let ended = false
  let written = 0

  // Bytes handed to the command, counted as they go rather than added up from the sizes the
  // manifest claims: what the end of this function compares against manifest.size is then a
  // measurement of what went into the pipe rather than a restatement of what was expected to.
  // It is also the only way a run that stopped in the middle of a chunk can say how much the
  // command actually read, and that number is in the message it fails with.
  const handed = (bytes) => {
    written += bytes
  }

  try {
    const manifestMessage = await searchManifest(client, chat, backupId)

    if (!manifestMessage) {
      throw new Error(
        `No manifest found for ${backupId} in ${chat}. ` +
          'Check the backup id, or use --chat to point at the right chat.',
      )
    }

    // The whole-backup arithmetic is in here and stays there: parseManifest adds the chunk
    // sizes up and compares them with manifest.size, refuses a layout where any chunk is not
    // where restore would look for it, and counts the list against the size. A manifest that
    // disagrees with itself therefore never reaches the line below, which is why this command
    // does not add the sum again — two copies of one piece of arithmetic is how they start
    // disagreeing, and the copy that is never reached is the one that would be wrong.
    const manifest = parseManifest(await readMessageBytes(client, manifestMessage))

    // Before the download, which is the only reason this check is worth making at all: tar
    // would say "not in gzip format" by itself, but only after every byte had arrived.
    if (requireGzipName && !isGzipName(manifest.name)) {
      throw new Error(
        `${backupId} is called ${manifest.name}, which does not claim to be gzipped, and tarx ` +
          `always extracts with "tar xzf -". Run "npx telstore restore ${backupId} -- tar xf -" ` +
          'if it is a plain tar archive. Refused now rather than after the whole backup has ' +
          'been downloaded, which is when tar would find out.',
      )
    }

    log(`Backup ${backupId}`)
    log(`Name   ${manifest.name} (${plural(manifest.chunks.length, 'chunk')}, ${formatBytes(manifest.size)})`)
    log(`From   ${describeChat(chat)}`)
    log(`Into   ${childArgv.join(' ')}\n`)

    const tmp = tempDirFor(configDir)
    await fs.mkdir(tmp, { recursive: true })

    // Before the first download. A command that cannot start costs nothing here and a whole
    // chunk if it is started later.
    child = spawn(childArgv, { stdio: ['pipe', 'inherit', 'inherit'] })
    onChild(child.kill)

    // Raced against every step below rather than checked between them: a command that dies
    // two minutes into an 1800MB download leaves that download with nowhere to go, and
    // finishing it first would be eight minutes spent on bytes nobody will read. Always
    // throws, so it can never be the value a race resolves with. The no-op catch is for the
    // window before the first race attaches a handler, exactly as `spawnProducer` does it.
    const gone = child.exited.then(
      ({ code, signal }) => {
        throw stoppedReading(childArgv, written, manifest.size, { code, signal })
      },
      (err) => {
        throw err
      },
    )
    gone.catch(() => {})

    const progress = createProgress({
      total: manifest.size,
      label: `Chunk 1/${manifest.chunks.length}`,
      write: warn,
    })

    try {
      for (const chunk of manifest.chunks) {
        const file = path.join(tmp, `${backupId}-${chunk.i}.chunk`)

        // Said before the open, for the reason the upload direction says it before its own:
        // the handler has to hold the name for the whole window in which the file can exist.
        onTempChunk(file)

        const handle = await fs.open(file, 'w+')

        try {
          progress.setLabel(`Chunk ${chunk.i + 1}/${manifest.chunks.length}`)

          const message = await Promise.race([getMessage(client, chat, chunk.msgId), gone])

          if (!message) {
            throw new Error(
              `Missing chunk ${chunk.i + 1}/${manifest.chunks.length}: message ${chunk.msgId} ` +
                `is no longer in ${chat}. This backup cannot be restored.`,
            )
          }

          const { sha256, size } = await Promise.race([
            downloadChunk(client, message, handle, 0, progress.advance, {
              retryOptions: { ...retryOptions, onRetry },
              concurrency: settings.downloadConcurrency,
            }),
            gone,
          ])

          if (size !== chunk.size) {
            throw new Error(
              `Chunk ${chunk.i + 1} arrived with ${size} bytes and the manifest records ` +
                `${chunk.size} — mismatch. ${received(childArgv, written)}`,
            )
          }

          if (sha256 !== chunk.sha256) {
            throw new Error(
              `Chunk ${chunk.i + 1} has a sha256 that does not match the manifest. ` +
                `${received(childArgv, written)}`,
            )
          }

          // Only now, and this line is the guarantee: everything above it is what makes the
          // difference between handing a command the backup and handing it whatever arrived.
          //
          // The write's own failure is worded here rather than reported as it arrived, because
          // a dead pipe is not a sentence anybody can act on: "write EPIPE" names the symptom,
          // and what happened is what `stoppedReading` says — minus the exit code, which this
          // path has not got. Usually it is not needed: measured on node 22, a command that
          // dies mid-chunk loses this race to `gone`, because the pipeline has to tear the
          // chunk file's read stream down before it can reject while `gone` is one microtask
          // behind the child's exit. What is left for this catch is the ending where no exit
          // status is coming at all — a command that closes its end of the pipe and goes on
          // working, `head -c 10` inside a shell that has more to do — where the write is the
          // only thing that will ever report anything.
          //
          // Which of the two things writeChunkTo can fail for happened is asked of the pipe
          // rather than of the error's code: a far end that has gone reports itself as EPIPE,
          // as ECONNRESET or as a premature close depending on when it went, and matching a
          // list of spellings is how such a check quietly stops matching. A destroyed stdin is
          // the fact under all of them — and writeChunkTo's other refusal, a chunk file
          // shorter than the manifest claims, is raised after its pipeline has finished
          // cleanly, so there the pipe is still open and the words it wrote about the chunk are
          // the ones kept (measured on node 22: a failing source under `{ end: false }` leaves
          // the destination open).
          const pumping = writeChunkTo(child.stdin, handle, size, { onProgress: handed }).catch(
            (err) => {
              if (!child.stdin.destroyed) throw err

              throw stoppedReading(childArgv, written, manifest.size)
            },
          )

          await Promise.race([pumping, gone])
        } finally {
          await discardChunkFile(handle, file, { writeErr, chunkSize: manifest.chunkSize })

          // Unsaid whether the removal worked or not: if it did there is nothing left to
          // remove, and if it did not, discardChunkFile has already named the file on stderr.
          onTempChunk(null)
        }
      }
    } finally {
      // Ended here rather than after the loop, so a failure mid-chunk still leaves the cursor
      // on a fresh line and "Error: ..." does not land on top of the bar.
      progress.finish()
    }

    // Unreachable if every chunk verified and every write moved the length it was given, which
    // is why it is worth keeping: it is the one check that does not trust the ones above it,
    // and it is counted from the bytes that went into the pipe rather than from the manifest.
    if (written !== manifest.size) {
      throw new Error(
        `telstore wrote ${written} bytes into ${childArgv[0]} and the manifest records ` +
          `${manifest.size}. Refusing to report a restore it cannot account for.`,
      )
    }

    // The command has had every byte the manifest names; EOF is how it is told so.
    child.stdin.end()

    const { code, signal } = await child.exited
    ended = true

    if (code !== 0 || signal !== null) {
      throw new Error(
        signal !== null
          ? `${childArgv[0]} was killed by ${signal} after receiving all ` +
            `${formatBytes(written)}. telstore is not reporting a restore on its behalf.`
          : `${childArgv[0]} exited ${code} after receiving all ${formatBytes(written)}. ` +
            'telstore is not reporting a restore on its behalf: every byte was correct and ' +
            'the command still did not finish.',
      )
    }

    log(`\nDone. ${formatBytes(written)} went through ${childArgv[0]}, which exited 0.`)

    return { id: backupId, size: written, chunks: manifest.chunks.length }
  } finally {
    // A run that fell over mid-chunk leaves the command alive and blocked on a pipe nothing is
    // going to write to again. Destroying the pipe is what turns that wait into something it
    // can act on; the kill is for a command that is not waiting on stdin at all.
    if (child && !ended) {
      child.stdin.destroy()
      child.kill()
    }

    onChild(null)

    await closeQuietly(client, disconnect, (err) =>
      warn(`\nWarning: could not close the Telegram connection: ${err.message}\n`),
    )
  }
}

// What the command got before this went wrong, in every message about a chunk that did not.
// A person deciding what to do next needs to know the difference between "it has half of my
// archive" and "it has nothing".
function received(childArgv, written) {
  return written === 0
    ? `${childArgv[0]} was given nothing.`
    : `${childArgv[0]} had already been given ${formatBytes(written)}, which was correct but ` +
      'is not the whole backup — whatever it did with that is incomplete.'
}

// A command that is gone while there are bytes left. Exit 0 is included on purpose: `head -c
// 10` exits 0 having read ten bytes of a gigabyte, and reporting that as a restore would be
// the confident wrong answer. Measured, not assumed — see the probe table in the spec.
//
// `exit` is null on the one ending where no exit status is coming: the command closed its end
// of the pipe and went on working. What happened is the same thing either way, so it is the
// same sentence, and only the clause naming the exit code is missing — waiting for one there
// would mean waiting without a deadline on a command that may never exit at all.
function stoppedReading(childArgv, written, total, exit = null) {
  const how =
    exit === null
      ? 'stopped reading'
      : exit.signal !== null
        ? `was killed by ${exit.signal}`
        : `exited ${exit.code}`

  return new Error(
    `${childArgv[0]} ${how} after reading ${formatBytes(written)} of ${formatBytes(total)}, ` +
      'so it did not receive the backup. Nothing in the chat changed.',
  )
}
