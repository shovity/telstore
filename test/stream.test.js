import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'

import { ChunkReader, writeChunkTo } from '../src/stream.js'

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

async function chunkFile(bytes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telstore-stream-'))
  const file = path.join(dir, 'chunk')

  await fs.writeFile(file, bytes)

  return { handle: await fs.open(file, 'r'), dir }
}

test('it writes exactly the length it was given, and no more', async () => {
  const { handle, dir } = await chunkFile(Buffer.from('abcdefghij'))
  const sink = new PassThrough()
  const seen = []

  sink.on('data', (bytes) => seen.push(bytes))

  // 4, not 10: the file may be longer than the chunk it holds when a download was cut short,
  // and the manifest's length is the one that decides.
  await writeChunkTo(sink, handle, 4)
  await handle.close()
  await fs.rm(dir, { recursive: true, force: true })

  assert.equal(Buffer.concat(seen).toString(), 'abcd')
})

// `createReadStream({ start: 0, end: length - 1 })` stops at the file's real end of data and
// does not complain when `end` reaches past it — measured, not assumed. A download cut short
// must not be reported as a chunk this function actually moved: the caller downstream adds
// `length` to its running total, not what this function actually wrote, so a short file here
// silently becomes a truncated stream handed to somebody's tar and a restore reported as done.
test('a chunk file shorter than the length it is asked for is refused, not silently truncated', async () => {
  const { handle, dir } = await chunkFile(Buffer.from('abcd'))
  const sink = new PassThrough()

  sink.resume()

  await assert.rejects(() => writeChunkTo(sink, handle, 10), (err) => {
    assert.match(err.message, /4/)
    assert.match(err.message, /10/)
    return true
  })

  await handle.close()
  await fs.rm(dir, { recursive: true, force: true })
})

// Two chunks down one pipe is the whole point: the command sees one stream, not one per chunk.
test('the destination stays open between chunks and the handle survives', async () => {
  const { handle, dir } = await chunkFile(Buffer.from('abcde'))
  const sink = new PassThrough()
  const seen = []

  sink.on('data', (bytes) => seen.push(bytes))

  await writeChunkTo(sink, handle, 5)
  await writeChunkTo(sink, handle, 5)

  assert.equal(sink.writableEnded, false)

  // Still ours: the read stream must not have closed the fd underneath us.
  const probe = Buffer.alloc(1)
  assert.equal((await handle.read(probe, 0, 1, 0)).bytesRead, 1)

  await handle.close()
  await fs.rm(dir, { recursive: true, force: true })
  assert.equal(Buffer.concat(seen).toString(), 'abcdeabcde')
})

test('progress is reported as the bytes go, not in one lump at the end', async () => {
  const { handle, dir } = await chunkFile(Buffer.alloc(200_000, 1))
  const sink = new PassThrough({ highWaterMark: 1024 })

  sink.resume()

  let reported = 0
  let calls = 0

  await writeChunkTo(sink, handle, 200_000, {
    onProgress: (bytes) => {
      reported += bytes
      calls += 1
    },
  })

  await handle.close()
  await fs.rm(dir, { recursive: true, force: true })

  assert.equal(reported, 200_000)
  assert.ok(calls > 1, `expected several progress calls, got ${calls}`)
})

// The test above only proves onProgress fires in pieces — a sink in flowing mode (`.resume()`)
// would report that same shape from an implementation that attached a raw 'data' listener and
// ignored write()'s return value, which is exactly the backpressure this function exists to
// honour rather than a readFile and one write: a chunk can be up to 1800MB and must never sit
// whole in this process's memory. This is the test that can tell the two apart: a destination
// that never acknowledges a write must stall the read, not finish reading regardless.
test('a destination that never acknowledges a write stalls the read rather than buffering the whole chunk', async () => {
  const size = 1_000_000
  const { handle, dir } = await chunkFile(Buffer.alloc(size, 1))

  // Holds every write() callback until release() is called, so nothing downstream of the first
  // unacknowledged write can be told "go ahead" — which is what a destination that stopped
  // reading (a real command whose stdin pipe is full) looks like from here.
  let gateOpen = false
  const pendingDones = []
  const sink = new Writable({
    write(_bytes, _encoding, done) {
      if (gateOpen) done()
      else pendingDones.push(done)
    },
  })

  let reported = 0
  const finished = writeChunkTo(sink, handle, size, {
    onProgress: (bytes) => {
      reported += bytes
    },
  })

  // A real pause, not a tick: a 1MB file reads from disk in well under this on any machine
  // this suite runs on, so an implementation that actually honours backpressure stalls and
  // stays stalled for the whole wait, while one that ignores it finishes reading regardless.
  await new Promise((resolve) => setTimeout(resolve, 200))

  const stalledAt = reported

  assert.ok(stalledAt > 0, 'expected the first write to have gone through before the stall')
  assert.ok(
    stalledAt < size,
    'a destination that never acknowledges a write must stall the read well short of the ' +
      `whole ${size}-byte file; saw ${stalledAt} bytes reported with nothing downstream ` +
      'ever accepting a write',
  )

  gateOpen = true
  while (pendingDones.length > 0) pendingDones.shift()()

  await finished
  await handle.close()
  await fs.rm(dir, { recursive: true, force: true })

  assert.equal(reported, size)
})

// A command that stops reading is the failure this function exists to surface. Silence here
// would become a restore reported as finished for a command that never saw it.
test('a destination that fails surfaces the failure', async () => {
  const { handle, dir } = await chunkFile(Buffer.alloc(64_000, 1))
  const sink = new Writable({
    write(_bytes, _encoding, done) {
      done(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    },
  })

  await assert.rejects(() => writeChunkTo(sink, handle, 64_000), /EPIPE/)

  await handle.close()
  await fs.rm(dir, { recursive: true, force: true })
})

test('a zero-length chunk writes nothing and does not throw', async () => {
  const { handle, dir } = await chunkFile(Buffer.alloc(0))
  const sink = new PassThrough()

  await writeChunkTo(sink, handle, 0)
  await handle.close()
  await fs.rm(dir, { recursive: true, force: true })

  assert.equal(sink.readableLength, 0)
})

// `pipeline` never cleans up after a destination it was told not to end, so every chunk left
// four handlers behind on the command's stdin: eight after four chunks, four distinct
// MaxListenersExceededWarnings torn through the progress bar by the eleventh, and at
// MAX_CHUNKS around 40,000 closures on one emitter, each retaining a finished pipeline's
// graph for the whole run. Nothing above this could see it — every other fixture here, and
// every one in test/restore-stream.test.js, is one or two chunks.
test('a destination fed many chunks is left with no listeners of this function', async () => {
  const { handle, dir } = await chunkFile(Buffer.alloc(1000, 1))
  const sink = new PassThrough()

  sink.resume()

  const counts = () => ({
    error: sink.listenerCount('error'),
    close: sink.listenerCount('close'),
    drain: sink.listenerCount('drain'),
    finish: sink.listenerCount('finish'),
    end: sink.listenerCount('end'),
  })

  await writeChunkTo(sink, handle, 1000)
  const afterOne = counts()

  await writeChunkTo(sink, handle, 1000)
  await writeChunkTo(sink, handle, 1000)

  assert.deepEqual(counts(), afterOne, 'a third chunk must not cost more listeners than the first')
  assert.deepEqual(afterOne, { error: 0, close: 0, drain: 0, finish: 0, end: 0 })

  await handle.close()
  await fs.rm(dir, { recursive: true, force: true })
})

// `write()` returning true means the destination took the bytes into its own buffer, not that
// they reached whatever is on the far end, so the EPIPE belonging to the last write of a chunk
// can arrive after the loop has run out of bytes to check it against. Reporting that chunk as
// one that went over is how a caller's running total comes to include bytes nobody received.
test('a destination that fails after the last byte was handed over is still a failure', async () => {
  const { handle, dir } = await chunkFile(Buffer.alloc(1000, 1))
  const sink = new Writable({
    write(_bytes, _encoding, done) {
      done()
      process.nextTick(() => sink.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })))
    },
  })

  await assert.rejects(() => writeChunkTo(sink, handle, 1000), /EPIPE/)

  await handle.close()
  await fs.rm(dir, { recursive: true, force: true })
})

// A destination that has already failed must not be handed the next buffer, and what the
// failure costs the caller is the reason: the bytes this function reports through onProgress are
// what the caller's running total and its failure message are built from, so one buffer written
// into a pipe that had already gone would be 64KB the message claims and nothing received.
//
// Twice over, because a failure can reach this loop in two different waits and one check does
// not cover both: while it is waiting for a destination that would not take the last buffer, and
// while it is waiting for the next read from a destination that took it and died afterwards.
async function pumpInto(sink, onProgress) {
  const { handle, dir } = await chunkFile(Buffer.alloc(200_000, 1))

  await assert.rejects(() => writeChunkTo(sink, handle, 200_000, { onProgress }), /EPIPE/)

  await handle.close()
  await fs.rm(dir, { recursive: true, force: true })
}

test('a destination that has failed is handed no further buffers', async () => {
  const refused = []
  // Small highWaterMark: the first write is not acknowledged, so the loop is inside its drain
  // wait when the failure arrives.
  const refusing = new Writable({
    highWaterMark: 1024,
    write(bytes, _encoding, done) {
      refused.push(bytes.length)
      done(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    },
  })

  let reportedToRefusing = 0
  await pumpInto(refusing, (bytes) => (reportedToRefusing += bytes))

  assert.equal(refused.length, 1, `expected one write, the destination was given ${refused.length}`)
  assert.equal(reportedToRefusing, refused[0])

  const accepted = []
  // A highWaterMark wide enough that the write is acknowledged at once, so the loop is waiting
  // on the next read — not on a drain — when the far end goes.
  const dyingAfter = new Writable({
    highWaterMark: 1_000_000,
    write(bytes, _encoding, done) {
      accepted.push(bytes.length)
      done()
      process.nextTick(() =>
        dyingAfter.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })),
      )
    },
  })

  let reportedToDying = 0
  await pumpInto(dyingAfter, (bytes) => (reportedToDying += bytes))

  assert.equal(accepted.length, 1, `expected one write, the destination was given ${accepted.length}`)
  assert.equal(reportedToDying, accepted[0])
})
