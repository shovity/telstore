import test from 'node:test'
import assert from 'node:assert/strict'

import { spawnProducer } from '../src/spawn.js'

// Real processes on purpose: `sh` and `sleep` are the two things this module exists to talk
// to, and a fake child cannot show that stdio was wired the way Node actually wires it. See
// docs/design/testing-blind-spots.md.

test('a command that exits 0 resolves with its code and its output', async () => {
  const child = spawnProducer(['sh', '-c', 'printf hello'])
  const chunks = []
  for await (const buf of child.stdout) chunks.push(buf)

  assert.equal(Buffer.concat(chunks).toString(), 'hello')
  assert.deepEqual(await child.exited, { code: 0, signal: null })
})

test('a non-zero exit is an answer, not a thrown error', async () => {
  const child = spawnProducer(['sh', '-c', 'exit 3'])
  for await (const _buf of child.stdout) { /* drain */ }

  assert.deepEqual(await child.exited, { code: 3, signal: null })
})

// stderr must not be captured on the same pipe stdout is: a command that writes only to
// stderr and exits 0 would look, on the piped stdout, exactly like a command that produced
// nothing at all. Checking stdout is empty and exited is still 0 is the only way to catch a
// wiring mistake that merges the two.
test('stderr does not leak into the captured stdout', async () => {
  const child = spawnProducer(['sh', '-c', 'echo oops 1>&2'])
  const chunks = []
  for await (const buf of child.stdout) chunks.push(buf)

  assert.equal(Buffer.concat(chunks).length, 0)
  assert.deepEqual(await child.exited, { code: 0, signal: null })
})

test('a command that does not exist names itself', async () => {
  const child = spawnProducer(['telstore-no-such-command-9f3a'])

  await assert.rejects(() => child.exited, /telstore-no-such-command-9f3a/)
})

// Deterministic: the assertion is that `signal` names the exact signal `kill` sent, not a
// race against a fixed timeout. `sleep 30` only exists so the process is still alive to be
// killed rather than having already exited on its own.
test('kill stops a command that would otherwise run forever', async () => {
  const child = spawnProducer(['sh', '-c', 'sleep 30'])
  child.kill('SIGTERM')

  const { code, signal } = await child.exited
  assert.equal(signal, 'SIGTERM')
  assert.equal(code, null)
})

// `exited` can be created before any caller has a chance to await it (the later upload task
// builds it, then reads stdout, then awaits it). If a rejected `exited` had no handler
// attached yet, Node would report an unhandledRejection for it — and under some
// configurations that takes the whole process down. This spawns a command that cannot start,
// deliberately waits a few ticks without touching `exited`, and checks nothing fired before
// the real await at the end attaches its own handler.
test('a not-yet-awaited rejection on exited does not raise an unhandledRejection', async () => {
  let unhandled = null
  const onUnhandledRejection = (err) => {
    unhandled = err
  }
  process.on('unhandledRejection', onUnhandledRejection)

  try {
    const child = spawnProducer(['telstore-no-such-command-9f3a'])

    // Give Node's unhandledRejection check every chance to fire before we attach a handler.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(unhandled, null)

    await assert.rejects(() => child.exited, /telstore-no-such-command-9f3a/)
  } finally {
    process.off('unhandledRejection', onUnhandledRejection)
  }
})
