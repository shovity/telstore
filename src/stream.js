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
  async close() {
    this.ended = true
    this.pending = null

    try {
      await this.iterator.return?.()
    } catch {
      // Nothing here can change what already went wrong.
    }
  }
}
