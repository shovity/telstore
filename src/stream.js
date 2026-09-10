import { promises as fs } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { formatBytes } from './progress.js'

// `handle.write(buffer)` is not guaranteed to write the whole buffer in one call. `bytes`
// becomes the chunk's recorded length, so trusting an unchecked write would let telstore
// claim more reached disk than actually did — silently wrong data, the one thing this
// project refuses to produce. Loops until every byte of `buffer` has landed, or throws if
// a write reports zero bytes written (which would otherwise spin forever rather than fail).
async function writeFully(handle, buffer) {
  let written = 0

  while (written < buffer.length) {
    const { bytesWritten } = await handle.write(buffer.subarray(written))

    if (bytesWritten === 0) {
      throw new Error('write wrote 0 bytes; refusing to spin retrying it')
    }

    written += bytesWritten
  }
}

// One reader over the life of an upload: it holds the iterator, so the bytes a chunk did
// not want are the first bytes of the next chunk rather than something dropped between
// two reads. Pulling through an async iterator is also what gives backpressure for free —
// while a chunk uploads, nothing calls next(), so the child blocks on its own write and
// the backlog stays in the pipe instead of in this process.
export class ChunkReader {
  constructor(readable) {
    this.readable = readable
    this.iterator = readable[Symbol.asyncIterator]()
    this.pending = null
    this.ended = false
    this.error = null
  }

  // Writes at most `limit` bytes into `handle`. `eof` means the stream is finished and
  // there will never be more — reported on the fill that meets the end, and on every one
  // after it. An error from the source propagates out of the awaited `next()` call as a
  // rejection of this method; it is never mistaken for `done`.
  //
  // Once the source has thrown, every later call rejects with that same error rather than
  // asking the iterator again. An async generator that has already thrown reports `done:
  // true` on the next `next()` call rather than throwing again, which — left unguarded —
  // would turn one real failure into a clean end of stream on the very next fill.
  async fill(handle, limit) {
    if (this.error !== null) throw this.error

    let bytes = 0

    while (bytes < limit) {
      if (this.pending === null) {
        if (this.ended) break

        let next
        try {
          next = await this.iterator.next()
        } catch (err) {
          this.error = err
          throw err
        }

        const { value, done } = next

        if (done) {
          this.ended = true
          break
        }

        this.pending = value
      }

      const room = limit - bytes
      const take = this.pending.length <= room ? this.pending : this.pending.subarray(0, room)

      await writeFully(handle, take)
      bytes += take.length

      this.pending =
        take.length === this.pending.length ? null : this.pending.subarray(take.length)
    }

    return { bytes, eof: this.ended && this.pending === null }
  }

  // What a failed upload calls on the way out. The iterator is abandoned mid-stream then, and
  // it is the iterator — not the caller — that holds the source open: returning it is what
  // releases the stream, so a producer blocked writing into a pipe nobody is reading stops
  // being blocked. Nothing it has to say can matter by then, because an error is already on
  // its way out of the caller, so a refusal to close is swallowed rather than thrown over it.
  //
  // The source is destroyed as well, and not for symmetry. `return()` on an async generator
  // that has never been started does not run the body, so it never reaches the `finally` a
  // Node stream's iterator destroys the stream in — measured on node 22, not assumed. A
  // reader closed before its first fill() would otherwise leave the child blocked on a pipe
  // with nothing to unblock it.
  async close() {
    // An abort is not an end. Arming the same sticky error a producer's own failure sets is
    // what stops a later fill() answering `eof: true` for a read that stopped with bytes
    // still unread — mistaking one for the other is the thing this class exists to refuse.
    // `??=` because the reason the source stopped is worth more than the fact that telstore
    // then closed it, and close() runs on the path where that reason is already on its way
    // out to the caller.
    this.error ??= new Error(
      'The stream was closed before it ended, so nothing more can be read from it.',
    )
    this.pending = null

    try {
      await this.iterator.return?.()
    } catch {
      // Nothing here can change what already went wrong.
    }

    try {
      this.readable.destroy?.()
    } catch {
      // As above.
    }
  }
}

// The other direction from ChunkReader, and unlike it this one can use the stream library as
// it comes. ChunkReader is hand-rolled because it has to stop at a chunk boundary and keep
// what it did not take; here the whole file is wanted, in order, and `pipeline` already does
// the two things that matter: it honours backpressure, so a chunk is never buffered in this
// process, and it rejects when the destination fails instead of going quiet.
//
// `{ end: false }` is what makes a command see one stream rather than one per chunk. Measured
// on node 22 rather than assumed, along with the fact that a FileHandle read stream opened
// this way leaves the handle open for the next chunk: `autoClose: false`.
export async function writeChunkTo(writable, handle, length, { onProgress = () => {} } = {}) {
  // `end: length - 1` is inclusive, so zero has to be turned away before it asks for byte -1.
  if (length === 0) return

  let seen = 0

  const counted = new Transform({
    transform(bytes, _encoding, done) {
      seen += bytes.length
      onProgress(bytes.length)
      done(null, bytes)
    },
  })

  // Not a 'data' listener on the source: attaching one switches the stream to flowing mode and
  // the backpressure this function exists to honour goes with it.
  const source = handle.createReadStream({ start: 0, end: length - 1, autoClose: false })

  await pipeline(source, counted, writable, { end: false })

  // `createReadStream` stops at the file's real end of data without complaining when `end`
  // reaches past it, so a chunk file shorter than `length` makes the pipeline above resolve
  // cleanly having moved too few bytes. That must not be read as success: the caller's running
  // total is built from `length`, the size it was told to expect, not from what this function
  // actually moved, so a short chunk here would become a truncated stream handed to somebody's
  // tar and reported as a finished restore — the one thing this project refuses to do.
  if (seen !== length) {
    throw new Error(
      `The chunk file held ${seen} bytes, but ${length} were asked for — the chunk is ` +
        'shorter than the manifest says it should be. Refusing to hand the destination a ' +
        'truncated stream and call it done.',
    )
  }
}

// The borrowing ends whether the chunk went out or the run fell over on it. close() failing
// must not be what stops the unlink — the file would sit there holding a whole chunk that
// nothing will ever remove — and a removal that fails must not replace the error already on
// its way out of the loop, so it is said on stderr rather than thrown.
//
// On writeErr rather than warn, like the prune report and for the same reason: a leaked file
// holding up to 1.8GB is not narration about a transfer that --silent asked to be spared. It
// is telstore leaving something on this machine that only the user can now clear up, and a
// caller silencing the progress bar has not asked to be kept in the dark about that.
export async function discardChunkFile(handle, file, { writeErr, chunkSize }) {
  try {
    await handle.close()
  } catch {
    // The file is about to be unlinked; whatever close had to say about it changes nothing.
  }

  try {
    await fs.rm(file, { force: true })
  } catch (err) {
    writeErr(
      `\nCould not remove the temporary chunk file ${file}: ${err.message}. It holds up to ` +
        `${formatBytes(chunkSize)} and telstore will not try again — remove it by hand.\n`,
    )
  }
}
