import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { ChunkReader } from '../src/stream.js'

import { tempDir } from './helpers.js'

test('fills exactly the limit and keeps the remainder for the next chunk', async () => {
  const dir = await tempDir('stream')
  const file = path.join(dir, 'chunk')
  const reader = new ChunkReader(Readable.from([Buffer.from('abcde'), Buffer.from('fghij')]))

  let handle = await fs.open(file, 'w')
  const first = await reader.fill(handle, 4)
  await handle.close()

  assert.deepEqual(first, { bytes: 4, eof: false })
  assert.equal(await fs.readFile(file, 'utf8'), 'abcd')

  handle = await fs.open(file, 'w')
  const second = await reader.fill(handle, 4)
  await handle.close()

  assert.deepEqual(second, { bytes: 4, eof: false })
  assert.equal(await fs.readFile(file, 'utf8'), 'efgh')
})

test('a stream shorter than the limit reports eof with what it had', async () => {
  const dir = await tempDir('stream')
  const file = path.join(dir, 'chunk')
  const reader = new ChunkReader(Readable.from([Buffer.from('abc')]))
  const handle = await fs.open(file, 'w')
  const result = await reader.fill(handle, 100)
  await handle.close()

  assert.deepEqual(result, { bytes: 3, eof: true })
  assert.equal(await fs.readFile(file, 'utf8'), 'abc')
})

test('an empty stream reports eof and no bytes', async () => {
  const dir = await tempDir('stream')
  const handle = await fs.open(path.join(dir, 'chunk'), 'w')
  const result = await new ChunkReader(Readable.from([])).fill(handle, 100)
  await handle.close()

  assert.deepEqual(result, { bytes: 0, eof: true })
})

test('a stream that ends exactly on a limit reports eof on the next fill, not this one', async () => {
  const dir = await tempDir('stream')
  const file = path.join(dir, 'chunk')
  const reader = new ChunkReader(Readable.from([Buffer.from('abcd')]))

  let handle = await fs.open(file, 'w')
  assert.deepEqual(await reader.fill(handle, 4), { bytes: 4, eof: false })
  await handle.close()

  handle = await fs.open(file, 'w')
  assert.deepEqual(await reader.fill(handle, 4), { bytes: 0, eof: true })
  await handle.close()
})

// The test that matters most: a stream error read as an end is exactly the silent
// truncation this whole feature exists to refuse. The error comes from the source
// itself (an async generator that throws after yielding), not from anything ChunkReader
// does, so this genuinely exercises the "does fill() let a producer's error surface"
// path rather than a mistake in the test's own setup.
test('an error from the stream is thrown, not read as an end', async () => {
  const dir = await tempDir('stream')
  const handle = await fs.open(path.join(dir, 'chunk'), 'w')
  const broken = Readable.from((async function* () {
    yield Buffer.from('ab')
    throw new Error('producer exploded')
  })())

  await assert.rejects(() => new ChunkReader(broken).fill(handle, 100), /producer exploded/)
  await handle.close()
})

// A later fill() must not resurrect an error a previous fill() already threw as a clean
// end-of-stream. This is a real failure mode, not a hypothetical one: Node's async
// generators report `done: true` (not a repeat throw) on the `next()` call that follows
// one that already threw, so a ChunkReader that asks the iterator again on the next fill
// — instead of remembering the failure — would turn one real error into exactly the
// silent truncation this whole feature exists to refuse, just one fill call later.
test('an error from the stream is not turned into a clean eof by a later fill', async () => {
  const dir = await tempDir('stream')
  const file = path.join(dir, 'chunk')
  const broken = Readable.from((async function* () {
    throw new Error('producer exploded')
  })())
  const reader = new ChunkReader(broken)

  const first = await fs.open(file, 'w')
  await assert.rejects(() => reader.fill(first, 100), /producer exploded/)
  await first.close()

  const second = await fs.open(file, 'w')
  await assert.rejects(() => reader.fill(second, 100), /producer exploded/)
  await second.close()
})

// A plain hand-rolled async iterable, not a `Readable`: `Readable.from` does its own
// one-step internal readahead when wrapping an async generator, which would make a pull
// count taken through a real stream meaningless here. `ChunkReader` only ever asks its
// source for `[Symbol.asyncIterator]()`, so this is a faithful source, not a workaround.
function countingSource(pieces) {
  const state = { pulls: 0 }
  const source = {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          if (i >= pieces.length) return { value: undefined, done: true }
          state.pulls += 1
          const value = pieces[i]
          i += 1
          return { value, done: false }
        },
      }
    },
  }
  return { source, state }
}

// Backpressure is the entire reason this module pulls through an async iterator instead
// of buffering ahead: while a chunk uploads for minutes, nothing must be pulled from the
// source. A ChunkReader that prefetched one piece ahead "to be ready" would still pass
// every test above this one, since none of them look at how many times the source was
// actually asked for its next piece.
test('does not pull from the source ahead of what the current fill needs', async () => {
  const dir = await tempDir('stream')
  const file = path.join(dir, 'chunk')
  const { source, state } = countingSource([Buffer.from('abcde'), Buffer.from('fghij')])
  const reader = new ChunkReader(source)

  let handle = await fs.open(file, 'w')
  const first = await reader.fill(handle, 3)
  await handle.close()

  assert.deepEqual(first, { bytes: 3, eof: false })
  assert.equal(state.pulls, 1, 'filling less than one piece must pull exactly that piece')

  handle = await fs.open(file, 'w')
  const second = await reader.fill(handle, 2)
  await handle.close()

  assert.deepEqual(second, { bytes: 2, eof: false })
  assert.equal(state.pulls, 1, 'a fill satisfied entirely from the pending remainder must not pull again')

  handle = await fs.open(file, 'w')
  const third = await reader.fill(handle, 5)
  await handle.close()

  assert.deepEqual(third, { bytes: 5, eof: false })
  assert.equal(state.pulls, 2, 'once the remainder is exhausted, the next fill pulls exactly one more piece')
})

// A fake FileHandle whose write() only ever accepts `maxPerCall` bytes, the way a real
// write(2) is allowed to behave. Records every call it actually received.
function shortWriteHandle(maxPerCall) {
  const calls = []
  return {
    calls,
    async write(buffer) {
      const take = buffer.subarray(0, Math.min(maxPerCall, buffer.length))
      calls.push(Buffer.from(take))
      return { bytesWritten: take.length }
    },
  }
}

// `fill` must not trust that one `handle.write(buffer)` call landed the whole buffer —
// `bytes` becomes the chunk's recorded length, so a believed-but-untrue write would let
// telstore claim more reached disk than actually did.
test('a short write from the handle is retried until the whole buffer lands', async () => {
  const reader = new ChunkReader(Readable.from([Buffer.from('abcdefghij')]))
  const handle = shortWriteHandle(3)

  const result = await reader.fill(handle, 100)

  assert.deepEqual(result, { bytes: 10, eof: true })
  assert.equal(Buffer.concat(handle.calls).toString(), 'abcdefghij')
  assert.ok(handle.calls.length > 1, 'a handle limited to 3 bytes per call must be called more than once')
})

// close() is what a failed upload calls on the way out, and what it releases is the source:
// an abandoned iterator holds a real child's stdout open, so a producer blocked writing into
// a pipe nobody is reading goes on waiting for a reader that is never coming back.
test('close releases the source', async () => {
  const stdout = Readable.from([Buffer.from('abc'), Buffer.from('def')])
  const reader = new ChunkReader(stdout)

  await reader.close()

  assert.equal(stdout.destroyed, true)
})

test('close on a source that refuses to be closed does not throw', async () => {
  const reader = new ChunkReader({
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ value: Buffer.from('ab'), done: false }),
      return: async () => {
        throw new Error('the producer refused to stop')
      },
    }),
  })

  await reader.close()
})

// An abort is not an end. A fill after close reporting `eof: true` would be this class making
// exactly the mistake it exists to prevent — a read that stopped with bytes still unread,
// handed back as a stream that finished — so close arms the same sticky error a producer's
// own failure would.
test('a fill after close is refused rather than reported as a clean end', async () => {
  const dir = await tempDir('stream')
  const file = path.join(dir, 'chunk')
  const reader = new ChunkReader(Readable.from([Buffer.from('abc'), Buffer.from('def')]))

  await reader.close()

  const handle = await fs.open(file, 'w')
  await assert.rejects(() => reader.fill(handle, 100), /closed before it ended/)
  await handle.close()
})

// The reason the source stopped is worth more than the fact that telstore then closed it, and
// close runs on a path where that error is already on its way out to the caller.
test('close does not overwrite the error the source already threw', async () => {
  const dir = await tempDir('stream')
  const file = path.join(dir, 'chunk')
  const broken = Readable.from((async function* () {
    throw new Error('producer exploded')
  })())
  const reader = new ChunkReader(broken)

  const first = await fs.open(file, 'w')
  await assert.rejects(() => reader.fill(first, 100), /producer exploded/)
  await first.close()

  await reader.close()

  const second = await fs.open(file, 'w')
  await assert.rejects(() => reader.fill(second, 100), /producer exploded/)
  await second.close()
})
