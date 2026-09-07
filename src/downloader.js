import { createHash } from 'node:crypto'
import { read as readCallback, write as writeCallback } from 'node:fs'
import { promisify } from 'node:util'

import { returnBigInt } from 'teleproto/Helpers.js'

import { DEFAULT_DOWNLOAD_CONCURRENCY, PART_SIZE, SLICE_SIZE } from './chunking.js'
import { withRetry } from './retry.js'
import { DEFAULT_STALL_MS, withStallTimeout } from './stall.js'

const write = promisify(writeCallback)
const read = promisify(readCallback)

// Read back in far bigger bites than the 512KB the network hands us: this loop is pure disk.
const HASH_READ_SIZE = 4 * 1024 * 1024

async function writeExactly(fd, buffer, position) {
  let written = 0

  while (written < buffer.length) {
    const { bytesWritten } = await write(fd, buffer, written, buffer.length - written, position + written)
    written += bytesWritten
  }
}

async function readExactly(fd, length, position) {
  const buffer = Buffer.allocUnsafe(length)
  let filled = 0

  while (filled < length) {
    const { bytesRead } = await read(fd, buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) {
      throw new Error(`Short read: needed ${length} bytes at offset ${position} but the file ended.`)
    }
    filled += bytesRead
  }

  return buffer
}

// The digest is taken from the assembled range on disk rather than from the buffers as they
// arrive. Once slices land out of order that is the only order left to hash in, and it is
// the better check anyway: a slice written at the wrong offset, two slices overlapping, or
// one silently skipped all show up here. It does not prove the bytes reached the platter —
// this read may well be served from the page cache — it proves the assembly.
//
// Exported because a resumed restore asks the same question of a .partial left by an earlier
// run. A second copy of it in restore.js is how two definitions of one check start to differ.
export async function hashRange(fd, offset, length) {
  const hash = createHash('sha256')

  for (let at = 0; at < length; at += HASH_READ_SIZE) {
    hash.update(await readExactly(fd, Math.min(HASH_READ_SIZE, length - at), offset + at))
  }

  return hash.digest('hex')
}

export async function downloadToFile(
  client,
  message,
  fd,
  { offset, onProgress, retryOptions, concurrency = DEFAULT_DOWNLOAD_CONCURRENCY, stallMs = DEFAULT_STALL_MS } = {},
) {
  const document = message?.media?.document

  if (!document) {
    throw new Error(`Message ${message?.id} has no file attached.`)
  }

  if (!Number.isFinite(offset)) {
    throw new Error(`offset must be a finite number, got: ${offset}`)
  }

  // A pool of fewer than one worker does no work. In the download path that means
  // Promise.all resolves at once and a chunk nobody fetched is reported as complete; in the
  // upload path the batch loop never advances and the process spins in microtasks, which not
  // even a test timeout can interrupt. Neither is something a caller should be able to ask
  // for by accident.
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      `Worker count must be a whole number of at least one, got: ${JSON.stringify(concurrency)}.`,
    )
  }

  // Telegram's own record of how long the document is. Taking the length from the caller
  // instead would make runRestore's size check compare the manifest against itself.
  const size = returnBigInt(document.size ?? 0).toJSNumber()

  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`Message ${message?.id} has a document with no usable size.`)
  }

  const sliceCount = Math.ceil(size / SLICE_SIZE)

  // One slice is one short stream. `done` lives outside withRetry, so a retried slice picks
  // up at its own watermark instead of fetching again what it already has.
  //
  // The two offsets are not the same number: `start + done` is a position inside the
  // document, which is where the stream resumes, while `offset + start + done` is a position
  // inside the file being assembled, which is where the bytes land.
  async function downloadSlice(index) {
    const start = index * SLICE_SIZE
    const length = Math.min(SLICE_SIZE, size - start)
    let done = 0

    await withRetry(async () => {
      // Iterated by hand rather than with `for await` so each part can be given a deadline:
      // a stalled stream yields nothing and raises nothing, and only a race against a timer
      // turns that silence into an error withRetry can act on. Nothing is lost by stepping
      // outside `for await` — teleproto's download iterator exposes `next` alone, so breaking
      // out of the loop never closed anything either.
      //
      // The media goes in its own argument, not inside the options: teleproto takes
      // `iterDownload(file, params)` where GramJS took a single `{ file, ... }` object, and
      // the options object arriving where the file belongs is not something a fake client
      // would ever refuse — it fails only against the real one, at getFileInfo.
      const stream = client.iterDownload(message.media, {
        offset: returnBigInt(start + done),
        requestSize: PART_SIZE,
      })
      const parts = stream[Symbol.asyncIterator]()

      for (;;) {
        const { value: buffer, done: ended } = await withStallTimeout(
          parts.next(),
          stallMs,
          () =>
            `Telegram stopped sending slice ${index + 1}/${sliceCount} of message ` +
            `${message?.id}: nothing arrived for ${Math.round(stallMs / 1000)}s after ` +
            `${done} of ${length} bytes.`,
        )

        if (ended) break

        // The stream runs to the end of the document; this slice stops at its own boundary.
        const take = Math.min(buffer.length, length - done)

        await writeExactly(fd, buffer.subarray(0, take), offset + start + done)
        done += take
        onProgress?.(take)

        if (done >= length) break
      }

      // A stream that ends before the slice's own boundary is a short delivery, not a
      // completed slice — without this, a hole here would surface only as a digest
      // mismatch, telling the user their data is corrupt when it was simply cut short.
      // Checked inside the retried callback so a transient short stream is retried, and a
      // stream that yields nothing at all still counts as a failure worth retrying.
      if (done < length) {
        throw new Error(
          `Slice ${index + 1}/${sliceCount} of message ${message?.id} ended after ${done} of ${length} bytes.`,
        )
      }
    }, retryOptions)
  }

  let next = 0
  let failed = false
  let failure = null

  const worker = async () => {
    for (;;) {
      // Stop handing out work the moment anything has failed: the chunk is lost either way,
      // and every further request is bandwidth spent on a file about to be thrown away.
      if (failed) return

      const index = next
      next += 1
      if (index >= sliceCount) return

      try {
        await downloadSlice(index)
      } catch (err) {
        // Not `failure ??= err`: a falsy rejection reason would leave `failure` falsy and the
        // throw below would read as success, turning a broken chunk into a silent one. The
        // first error is the one kept — later ones are usually consequences of the shutdown
        // rather than the cause.
        if (!failed) {
          failed = true
          failure = err
        }
        return
      }
    }
  }

  // Every worker absorbs its own error above, so none of these promises rejects and none can
  // become an unhandledRejection that hides the real one. This await is also what guarantees
  // no write is still in flight when the function returns.
  await Promise.all(Array.from({ length: Math.min(concurrency, sliceCount) }, worker))

  if (failed) throw failure

  return { sha256: await hashRange(fd, offset, size), size }
}
