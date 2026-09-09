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
