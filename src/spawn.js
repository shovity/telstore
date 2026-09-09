import { spawn } from 'node:child_process'

// stderr is inherited, never captured: when a producer command fails it explains itself in
// its own words, on the stream the user is already watching. telstore adds the exit code
// and what it did about it, and does not paraphrase.
//
// `exited` can be built before the caller has any chance to await it — the caller reads
// `stdout` first, and only awaits `exited` once the stream ends. A rejected promise with no
// handler attached yet makes Node report an unhandledRejection, so a no-op `.catch` is
// attached here immediately. That does not consume the rejection: the `exited` this function
// returns is the same promise, and `await`ing it later still resolves or rejects exactly as
// it would have.
export function spawnProducer(argv, { stdio = ['ignore', 'pipe', 'inherit'] } = {}) {
  const [command, ...args] = argv
  const child = spawn(command, args, { stdio })

  const exited = new Promise((resolve, reject) => {
    child.on('error', (err) => {
      reject(
        new Error(
          err.code === 'ENOENT'
            ? `Cannot run ${command}: no such command on this machine.`
            : `Cannot run ${command}: ${err.message}`,
        ),
      )
    })

    child.on('close', (code, signal) => resolve({ code, signal }))
  })
  exited.catch(() => {})

  return {
    stdout: child.stdout,
    stdin: child.stdin,
    exited,
    kill: (signal = 'SIGTERM') => child.kill(signal),
  }
}
