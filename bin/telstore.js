#!/usr/bin/env node
import { unlinkSync } from 'node:fs'

import { route, HELP, interruptMessage } from '../src/cli.js'

// Each command is imported where it runs, not here. Importing all nine up front pulled
// teleproto into every invocation — about 0.3s and 45MB — including `--help`, `config` and
// `logout`, which never open a socket. `src/cli.js` stays a static import because parsing the
// arguments is the one thing every run does, and nothing it touches reaches the network.

const SIGINT_EXIT_CODE = 130

// How long the process waits for a run to unwind itself before it stops waiting. Only a
// rollback that cannot reach Telegram ever gets this far, and the alternative to a deadline
// is a terminal held open by a network that is never coming back, with no way out but a
// second Ctrl-C nobody has been told to press.
const CLEANUP_DEADLINE_MS = 60_000

// Which command is running when Ctrl-C arrives — each one tells a different truth
// about whether progress was saved, so we need to know which to pick the right line.
// The backup id arrives a moment later, once upload knows which backup this run is.
let currentCommand = null
let currentBackupId = null

// Only a stream upload sets these. `streaming` is known from the command line, before the run
// has said anything, because the wrong message is the file one that promises a resume; the
// other two arrive once the run has something in the chat and a way to unwind it.
let streaming = false
let currentChat = null
let abortRun = null
let interrupting = false
let deadline = null

// The run is over — it finished, or it unwound itself and threw. Nothing after this point is
// something Ctrl-C can be about: the process is only waiting for its own output to flush.
let settled = false

// This process is already on its way out, and has already said why.
let leaving = false

// The chunk file a stream upload is buffering into right now, or null. The run removes its
// own on every ending it gets to run code for; this exists for the one ending it does not.
let tempChunk = null

// The command a streaming restore is feeding, if one is running. A stream upload unwinds
// cooperatively and kills its own child on the way; a restore has nothing in the chat to
// unwind, so Ctrl-C leaves at once — and leaving without this would let tar go on writing
// files into somebody's directory after telstore had said it stopped. Synchronous, like
// dropTempChunk and for the same reason: anything awaited here would be waiting on the run
// this exit exists to stop waiting for.
let killChild = null

function stopChild() {
  const kill = killChild

  if (kill === null) return

  killChild = null

  try {
    kill()
  } catch {
    // Already gone. There is nothing this could do about it and nothing worth saying.
  }
}

// What a Ctrl-C that will not wait can still do about that file, and it has to be exactly this
// shape: local and unawaited, because anything awaited here would be waiting on the very run
// this exit exists to stop waiting for. `unlinkSync` holds no handle, opens no socket and
// cannot hang. Removing a file this process still has open is not a problem where it matters
// either: on POSIX the name goes now and the space comes back as the process dies. A platform
// that refuses to unlink an open file leaves the user with a file holding up to a whole chunk,
// so that ending — and only that ending — prints.
//
// It is not free, though, and "one syscall" is the wrong number to quote. Three costs, and
// they are three different numbers: the call removes a name and returns in microseconds; the
// goodbye line still reaches the terminal in about 1.2ms; and then the extents are freed at
// the *last close*, which is process teardown. Measured on ext4, SIGINT to exit, file still
// open: 60-100ms against 29-43ms for a 64MB chunk, 596-658ms against 45-56ms at 512MB, and
// 1131-1646ms against 45-64ms at the default 1792MB — so at default settings the prompt comes
// back about a second after the message does. Nothing avoids that second: whoever runs `rm`
// on the leftover instead pays the same teardown. docs/design/data-integrity.md has the
// conditions.
//
// Silence on success is the point rather than an omission: the rule is that nothing telstore
// leaves behind goes unnamed, and this leaves nothing behind.
function dropTempChunk() {
  const file = tempChunk

  if (file === null) return ''

  tempChunk = null

  try {
    unlinkSync(file)
    return ''
  } catch (err) {
    // Already gone — the run's own discard won the race — is not something to report.
    if (err.code === 'ENOENT') return ''

    return (
      `\nThe chunk telstore was buffering is still on this machine: ${file} ` +
      `(${err.message}). It holds up to one chunk — remove it by hand.\n`
    )
  }
}

// A batch clears each finished item's record as it goes, so by the time Ctrl-C lands these
// are transfers no second run should touch. Ctrl-C needs their names to say so.
const finished = []

// Every exit Ctrl-C leads to comes through here. Through exitWhenFlushed rather than straight
// to process.exit, because on a pipe stderr is asynchronous, and the line most at risk of
// being cut in half is the one below carrying the command that removes the leftovers.
function leave(message) {
  stopChild()

  // Called twice means Ctrl-C landed again while the first line was still flushing, or the
  // deadline arrived on top of it. There is nothing more to say, and someone pressing it a
  // second time is asking to be gone rather than read to.
  if (leaving) process.exit(SIGINT_EXIT_CODE)

  leaving = true

  // Every exit the handler leads to comes through here, which is why the borrowed disk is
  // given back here rather than in the second-Ctrl-C arm alone: the deadline running out
  // ends the process in exactly the same place, and so does a Ctrl-C on a run that had
  // nothing to unwind. One write, so the two lines cannot be split by a slow pipe.
  process.stderr.write(message + dropTempChunk())
  exitWhenFlushed(SIGINT_EXIT_CODE)
}

// Said when the waiting ends without the rollback having finished — because someone pressed
// Ctrl-C again, or because the deadline above ran out. Neither knows how far the removal got,
// so both point at the command that finishes it by hand.
function leaveNow() {
  leave(
    interruptMessage(currentCommand, {
      backupId: currentBackupId,
      done: finished,
      stream: true,
      again: true,
      chat: currentChat,
    }),
  )
}

process.on('SIGINT', () => {
  // A passphrase prompt has stdin in raw mode, and process.exit skips readline's own cleanup.
  // Without this, Ctrl-C hands back a shell that no longer echoes what is typed into it.
  if (process.stdin.isTTY) process.stdin.setRawMode(false)

  // Checked before anything else, because every message below describes a run that is still
  // going. Said about one that has settled they are all false: a removal that is not running,
  // leftovers that were already removed, a resume for a backup that is finished and valid.
  // The window is real — exitWhenFlushed waits up to two seconds on a pipe nobody is reading.
  if (settled) {
    leave(interruptMessage(null))
    return
  }

  // A second Ctrl-C is someone saying they will not wait.
  if (interrupting) {
    leaveNow()
    return
  }

  // Everything else keeps what it has sent on purpose — a file upload's chunks are what the
  // next run resumes onto — so there is nothing to unwind and Ctrl-C is the immediate exit it
  // has always been.
  if (!abortRun) {
    leave(
      interruptMessage(currentCommand, {
        backupId: currentBackupId,
        done: finished,
        stream: streaming,
      }),
    )
    return
  }

  interrupting = true
  process.stderr.write(
    interruptMessage(currentCommand, {
      backupId: currentBackupId,
      done: finished,
      stream: true,
    }),
  )

  // Deliberately not unref'd, and it does two jobs. It is the deadline; it is also the one
  // handle that keeps this process alive while the rollback runs. Node leaves with 0 the
  // moment nothing is pending, and a rollback waiting on something that holds no handle
  // would end the process mid-removal reporting success, with the chunks still in the chat.
  // The upload arm clears it, so a rollback that finishes normally never meets the deadline.
  deadline = setTimeout(leaveNow, CLEANUP_DEADLINE_MS)

  // The abort itself only asks; the waiting is done by main, which is still awaiting the run.
  // Nothing it could reject with matters here — the run reports its own end.
  Promise.resolve(abortRun()).catch(() => {})
})

async function main() {
  let parsed

  try {
    parsed = route(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n\n${HELP}`)
    process.exitCode = 2
    return
  }

  currentCommand = parsed.command

  switch (parsed.command) {
    case 'help':
      process.stdout.write(HELP)
      return

    case 'login': {
      const { runLogin } = await import('../src/commands/login.js')

      await runLogin({
        args: parsed.args,
        token: Boolean(parsed.options.token),
        verbose: Boolean(parsed.options.verbose),
      })
      return
    }

    case 'logout': {
      const { runLogout } = await import('../src/commands/logout.js')

      await runLogout()
      return
    }

    case 'down': {
      const { runDown } = await import('../src/commands/down.js')

      await runDown(parsed.args, parsed.options)
      return
    }

    case 'list': {
      const { runList } = await import('../src/commands/list.js')

      await runList(parsed.options)
      return
    }

    case 'status': {
      const { runStatus } = await import('../src/commands/status.js')

      await runStatus(parsed.options)
      return
    }

    case 'config': {
      const { runConfig } = await import('../src/commands/config.js')

      await runConfig(parsed.args, parsed.options)
      return
    }

    case 'token': {
      const { runToken } = await import('../src/commands/token.js')

      await runToken(parsed.args, parsed.options)
      return
    }

    case 'upload': {
      // `telstore a.tar -- tar cf ./a`: one name, and the bytes are what the command writes
      // rather than a file on disk. route has already refused every other shape of that line.
      if (parsed.childArgv) {
        const { runStreamUpload } = await import('../src/commands/upload-stream.js')

        streaming = true

        try {
          await runStreamUpload(parsed.args[0], parsed.childArgv, parsed.options, {
            onBackupId: (id) => {
              currentBackupId = id
            },
            onAbortable: (abort, { chat } = {}) => {
              abortRun = abort
              currentChat = chat ?? null
            },
            onTempChunk: (file) => {
              tempChunk = file
            },
          })
        } catch (err) {
          // Only the run that stopped because Ctrl-C asked it to, which has already said so
          // and already put the chat back as it found it. Everything else — a rollback that
          // could not finish included, since that throws an error of its own — is a failure
          // the handler below reports.
          if (!err?.interrupted) throw err

          process.stderr.write('\nStopped. Nothing this run sent was left in the chat.\n')
          process.exitCode = SIGINT_EXIT_CODE
        } finally {
          // Nothing left to unwind, and nothing left to say about it: whichever way the run
          // ended, it ended. The deadline that was holding the process open goes with it.
          settled = true
          abortRun = null
          if (deadline) clearTimeout(deadline)
        }

        return
      }

      const { runUploads } = await import('../src/commands/upload.js')

      const { failed } = await runUploads(parsed.args, parsed.options, {
        // Only route saw the command line, and an unquoted note is told apart from a plain
        // missing file by where the words sat on it.
        filesAfterNote: parsed.filesAfterNote,
        onBackupId: (id) => {
          currentBackupId = id
        },
        onFileDone: (file) => {
          if (file.id) finished.push(file)
        },
      })

      // A batch reports its own failures by name and has already said so on stdout; the exit
      // code is what carries that out to whatever ran telstore.
      if (failed > 0) process.exitCode = 1
      return
    }

    case 'restore': {
      // The spec's stage 2, and the refusal that stood here is gone: the bytes were asked for
      // on a command's stdin and that is now where they go.
      if (parsed.childArgv) {
        const { runRestoreStream } = await import('../src/commands/restore-stream.js')

        // So Ctrl-C says the restore sentence rather than the upload one.
        streaming = true

        await runRestoreStream(parsed.args[0], parsed.childArgv, parsed.options, {
          // Only the alias promises gzip. The general form promises nothing and is asked
          // nothing, which is how `restore <id> -- tar xf -` stays useful.
          requireGzipName: parsed.shortcut === 'tarx',
          onBackupId: (id) => {
            currentBackupId = id
          },
          onTempChunk: (file) => {
            tempChunk = file
          },
          onChild: (kill) => {
            killChild = kill
          },
        })
        return
      }

      if (!parsed.args[0]) {
        throw new Error('Missing backup id. Example: npx telstore restore telstore-20260905-7f3a91')
      }

      const { runRestores } = await import('../src/commands/restore.js')

      const { failed } = await runRestores(parsed.args, parsed.options, {
        onBackupId: (id) => {
          currentBackupId = id
        },
        onRestoreDone: (item) => {
          finished.push(item)
        },
      })

      if (failed > 0) process.exitCode = 1
      return
    }

    case 'verify': {
      if (!parsed.args[0]) {
        throw new Error('Missing backup id. Example: npx telstore verify telstore-20260905-7f3a91')
      }

      const { runVerifies } = await import('../src/commands/verify.js')

      const { failed } = await runVerifies(parsed.args, parsed.options)

      // A backup that is damaged, and one telstore could not look up at all, both mean the
      // run did not find what it was asked to check. Whatever runs telstore learns that here.
      if (failed > 0) process.exitCode = 1
      return
    }

    case 'delete': {
      if (!parsed.args[0]) {
        throw new Error('Missing backup id. Example: npx telstore delete telstore-20260905-7f3a91')
      }

      const { runDeletes } = await import('../src/commands/delete.js')

      const { failed } = await runDeletes(parsed.args, parsed.options)

      if (failed > 0) process.exitCode = 1
      return
    }

    default:
      throw new Error(`Unknown command: ${parsed.command}`)
  }
}

// Written for GramJS, which kept "exported senders" alive behind a 30-second release timer
// that neither disconnect() nor destroy() could clear — both walked a Map with Object.values
// and missed every entry, so a command printed "Done" and then hung for half a minute, during
// which Ctrl-C falsely reported that nothing had been saved. teleproto replaced that pool
// wholesale and closes it on destroy(). This stays anyway: a CLI that has written its last
// line has nothing left to wait for, and one stray timer in any dependency is all it takes
// for the wait to come back.
function exitWhenFlushed(code) {
  // The empty writes exist only to borrow their callbacks: they fire after everything
  // queued earlier has flushed, so nothing is lost when stdout/stderr is not a TTY.
  let pending = 2

  const done = () => {
    pending -= 1
    if (pending === 0) process.exit(code)
  }

  // Safety net: exit anyway if a callback never arrives (the pipe is already closed).
  setTimeout(() => process.exit(code), 2000).unref()

  process.stdout.write('', done)
  process.stderr.write('', done)
}

main().then(
  () => {
    exitWhenFlushed(process.exitCode ?? 0)
  },
  (err) => {
    process.stderr.write(`Error: ${err.message}\n`)

    // A run the handler asked to stop leaves with 130 whatever it then had to say: a rollback
    // that could not finish is still an interrupted run, not a command that failed on its own.
    const code = interrupting ? SIGINT_EXIT_CODE : 1

    process.exitCode = code
    exitWhenFlushed(code)
  },
)
