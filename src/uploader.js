import { createHash, randomBytes } from 'node:crypto'
import { read as readCallback } from 'node:fs'
import { promisify } from 'node:util'

import { Api } from 'teleproto'
import { readBigIntFromBuffer } from 'teleproto/Helpers.js'

import { DEFAULT_UPLOAD_CONCURRENCY, PART_SIZE, MAX_PARTS } from './chunking.js'
import { withRetry } from './retry.js'
import { DEFAULT_STALL_MS, withStallTimeout } from './stall.js'

const read = promisify(readCallback)

// Telegram splits its upload API by file size: only files above 10MB may use the
// "big" family. teleproto picks the same threshold (LARGE_FILE_THRESHOLD in
// node_modules/teleproto/client/uploads.js), and telstore follows it.
export const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024

async function readExactly(fd, length, position) {
  // allocUnsafe skips zero-filling 512KB per part — about 0.4s of memset per 1800MB chunk,
  // on the same thread that drives the in-flight requests. Safe only because the loop below
  // either fills every byte or throws: no uninitialised byte can reach a request or the hash.
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

export async function uploadRange(client, fd, options) {
  const {
    offset,
    length,
    fileName,
    concurrency = DEFAULT_UPLOAD_CONCURRENCY,
    partSize = PART_SIZE,
    onProgress,
    retryOptions,
    stallMs = DEFAULT_STALL_MS,
    // Applied to each part as it is read, in order, before it is hashed or sent — so the sha256
    // this returns is of the bytes Telegram holds, and a retry resends the same transformed
    // buffer rather than transforming again. It is what encryption rides on, and this file knows
    // nothing else about it.
    transform = (bytes) => bytes,
  } = options

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

  const totalParts = Math.ceil(length / partSize)

  if (totalParts > MAX_PARTS) {
    throw new Error(
      `This byte range needs ${totalParts} parts, but Telegram accepts at most 4000 parts per file.`,
    )
  }

  const isLarge = length > LARGE_FILE_THRESHOLD
  const fileId = readBigIntFromBuffer(randomBytes(8), true, true)
  const hash = createHash('sha256')

  function partRequest(part, bytes) {
    if (isLarge) {
      return new Api.upload.SaveBigFilePart({
        fileId,
        filePart: part,
        fileTotalParts: totalParts,
        bytes,
      })
    }

    return new Api.upload.SaveFilePart({ fileId, filePart: part, bytes })
  }

  for (let start = 0; start < totalParts; start += concurrency) {
    const end = Math.min(start + concurrency, totalParts)
    const sending = []
    let sendError = null
    let sendFailed = false
    let readError = null

    // Read sequentially so the hash sees parts in order, but send in parallel.
    try {
      for (let part = start; part < end; part += 1) {
        const partOffset = part * partSize
        const partLength = Math.min(partSize, length - partOffset)
        const bytes = transform(await readExactly(fd, partLength, offset + partOffset), partOffset)

        hash.update(bytes)

        // Attach the handler when the promise is created rather than waiting for the
        // Promise.all at the end of the batch: if readExactly throws on a later part,
        // an already-pushed promise with no handler becomes an unhandledRejection and
        // hides the real error.
        sending.push(
          withRetry(
            () =>
              // Same exposure as the download path: a request the server accepts and never
              // answers settles neither way, so without a deadline this await would hold the
              // batch open forever and the upload would end without a word.
              withStallTimeout(
                client.invoke(partRequest(part, bytes)),
                stallMs,
                () =>
                  `Telegram stopped acknowledging part ${part + 1}/${totalParts} of ` +
                  `${fileName}: nothing back for ${Math.round(stallMs / 1000)}s.`,
              ),
            retryOptions,
          ).then(
            () => onProgress?.(partLength),
            (err) => {
              // Not `sendError ??= err`: if the rejection reason is falsy
              // (undefined/null), that assignment still sets sendError to a falsy
              // value and the `if (sendError)` below reads as "no error" — swallowing
              // a failed send and turning it into a fake success.
              if (!sendFailed) {
                sendFailed = true
                sendError = err
              }
            },
          ),
        )
      }
    } catch (err) {
      readError = err
    }

    // Every promise in `sending` already absorbed its own error above, so they all
    // resolve; this await only guarantees no request is still in flight when we throw.
    await Promise.all(sending)

    if (readError) throw readError
    if (sendFailed) throw sendError
  }

  const inputFile = isLarge
    ? new Api.InputFileBig({ id: fileId, parts: totalParts, name: fileName })
    : new Api.InputFile({ id: fileId, parts: totalParts, name: fileName, md5Checksum: '' })

  return {
    inputFile,
    sha256: hash.digest('hex'),
    parts: totalParts,
  }
}
