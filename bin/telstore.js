#!/usr/bin/env node
import { route, HELP, interruptMessage } from '../src/cli.js'

// Each command is imported where it runs, not here. Importing all nine up front pulled
// teleproto into every invocation — about 0.3s and 45MB — including `--help`, `config` and
// `logout`, which never open a socket. `src/cli.js` stays a static import because parsing the
// arguments is the one thing every run does, and nothing it touches reaches the network.

const SIGINT_EXIT_CODE = 130

// Which command is running when Ctrl-C arrives — each one tells a different truth
// about whether progress was saved, so we need to know which to pick the right line.
// The backup id arrives a moment later, once upload knows which backup this run is.
let currentCommand = null
let currentBackupId = null

// A batch clears each finished item's record as it goes, so by the time Ctrl-C lands these
// are transfers no second run should touch. Ctrl-C needs their names to say so.
const finished = []

process.on('SIGINT', () => {
  // A passphrase prompt has stdin in raw mode, and process.exit skips readline's own cleanup.
  // Without this, Ctrl-C hands back a shell that no longer echoes what is typed into it.
  if (process.stdin.isTTY) process.stdin.setRawMode(false)

  process.stderr.write(
    interruptMessage(currentCommand, { backupId: currentBackupId, done: finished }),
  )
  process.exit(SIGINT_EXIT_CODE)
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
    process.exitCode = 1
    exitWhenFlushed(1)
  },
)
