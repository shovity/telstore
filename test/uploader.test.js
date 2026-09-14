import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { Api } from 'teleproto'

import { uploadRange, LARGE_FILE_THRESHOLD } from '../src/uploader.js'

import { tempDir } from './helpers.js'

/**
 * Fake client: records every upload request so tests can reassemble the parts,
 * compare them against the source range, and check which API was used.
 */
function fakeClient({
  failFirstPart = false,
  failEveryPart = false,
  rejectPartWithUndefined = null,
} = {}) {
  const requests = []
  let failed = false
  let rejectedWithUndefined = false

  return {
    requests,
    async invoke(request) {
      if (failEveryPart) {
        throw new Error('network error')
      }
      if (failFirstPart && !failed && request.filePart === 0) {
        failed = true
        throw new Error('network error')
      }
      if (
        rejectPartWithUndefined !== null &&
        !rejectedWithUndefined &&
        request.filePart === rejectPartWithUndefined
      ) {
        rejectedWithUndefined = true
        // eslint-disable-next-line no-throw-literal
        throw undefined
      }
      requests.push({
        className: request.className,
        fileId: request.fileId.toString(),
        filePart: request.filePart,
        fileTotalParts: request.fileTotalParts,
        bytes: Buffer.from(request.bytes),
      })
      return true
    },
  }
}

function reassemble(requests) {
  return Buffer.concat(
    [...requests].sort((a, b) => a.filePart - b.filePart).map((r) => r.bytes),
  )
}

async function tempFile(content) {
  const dir = await tempDir('upload')
  const file = path.join(dir, 'source.bin')
  await fs.writeFile(file, content)
  const handle = await fs.open(file, 'r')
  return { file, handle }
}

test('uploads a whole file smaller than one part', async () => {
  const content = randomBytes(1000)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  const result = await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'telstore-1.part0001',
    partSize: 512,
  })

  assert.equal(result.parts, 2)
  assert.equal(client.requests.length, 2)
  assert.deepEqual(reassemble(client.requests), content)
  await handle.close()
})

test('the returned sha256 is that of the uploaded range', async () => {
  const content = randomBytes(3000)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  const result = await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'x',
    partSize: 512,
  })

  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'))
  await handle.close()
})

test('uploads only the requested range, not the whole file', async () => {
  const content = randomBytes(5000)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  const result = await uploadRange(client, handle.fd, {
    offset: 1000,
    length: 2000,
    fileName: 'x',
    partSize: 512,
  })

  const expected = content.subarray(1000, 3000)
  assert.deepEqual(reassemble(client.requests), expected)
  assert.equal(result.sha256, createHash('sha256').update(expected).digest('hex'))
  await handle.close()
})

test('every part shares one fileId and the numbering is complete', async () => {
  const content = randomBytes(3000)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'x',
    partSize: 512,
  })

  const fileIds = new Set(client.requests.map((r) => r.fileId))
  assert.equal(fileIds.size, 1)
  assert.deepEqual(
    client.requests.map((r) => r.filePart).sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5],
  )
  await handle.close()
})

test('several batches (concurrency below the part count): no part is skipped or sent twice', async () => {
  const content = randomBytes(3000)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  const result = await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'x',
    partSize: 512,
    concurrency: 2,
  })

  assert.equal(result.parts, 6)

  const filePartValues = client.requests.map((r) => r.filePart)
  assert.deepEqual([...filePartValues].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5])
  assert.equal(new Set(filePartValues).size, filePartValues.length)

  assert.deepEqual(reassemble(client.requests), content)
  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'))
  await handle.close()
})

test('the last part is shorter than the part size', async () => {
  const content = randomBytes(1025)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  await uploadRange(client, handle.fd, { offset: 0, length: content.length, fileName: 'x', partSize: 512 })

  const last = client.requests.find((r) => r.filePart === 2)
  assert.equal(last.bytes.length, 1)
  await handle.close()
})

test('a range of 10MB or less uses SaveFilePart and returns an InputFile', async () => {
  const content = randomBytes(1000)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  const result = await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'telstore-1.part0001',
    partSize: 512,
  })

  assert.ok(
    client.requests.every((r) => r.className === 'upload.SaveFilePart'),
    `must use SaveFilePart: ${client.requests.map((r) => r.className).join(', ')}`,
  )
  assert.ok(
    client.requests.every((r) => r.fileTotalParts === undefined),
    'SaveFilePart has no fileTotalParts field',
  )

  assert.ok(result.inputFile instanceof Api.InputFile)
  assert.ok(!(result.inputFile instanceof Api.InputFileBig))
  assert.equal(result.inputFile.name, 'telstore-1.part0001')
  assert.equal(result.inputFile.parts, 2)
  assert.equal(result.inputFile.md5Checksum, '')
  await handle.close()
})

test('exactly 10MB is still on the small side of the threshold', async () => {
  const content = randomBytes(LARGE_FILE_THRESHOLD)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  const result = await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'telstore-1.part0001',
  })

  assert.ok(result.inputFile instanceof Api.InputFile)
  assert.ok(client.requests.every((r) => r.className === 'upload.SaveFilePart'))
  await handle.close()
})

test('a range above 10MB uses SaveBigFilePart and returns an InputFileBig', async () => {
  const content = randomBytes(LARGE_FILE_THRESHOLD + 1)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  const result = await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'telstore-1.part0001',
  })

  assert.ok(
    client.requests.every((r) => r.className === 'upload.SaveBigFilePart'),
    `must use SaveBigFilePart: ${client.requests.map((r) => r.className).join(', ')}`,
  )
  assert.ok(
    client.requests.every((r) => r.fileTotalParts === result.parts),
    'SaveBigFilePart must carry fileTotalParts',
  )

  assert.ok(result.inputFile instanceof Api.InputFileBig)
  assert.equal(result.inputFile.name, 'telstore-1.part0001')
  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'))
  await handle.close()
})

test('a failed part is retried and the data stays intact', async () => {
  const content = randomBytes(2000)
  const { handle } = await tempFile(content)
  const client = fakeClient({ failFirstPart: true })

  await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'x',
    partSize: 512,
    retryOptions: { baseDelayMs: 1, sleep: async () => {} },
  })

  assert.deepEqual(reassemble(client.requests), content)
  await handle.close()
})

test('a part rejected with a falsy reason (undefined) must still throw, never count as success', async () => {
  const content = randomBytes(2000)
  const { handle } = await tempFile(content)
  // Part 1 rejects with `undefined` — exactly the Promise.reject(undefined) that
  // `sendError ??= err` would swallow, since the assigned value stays falsy.
  const client = fakeClient({ rejectPartWithUndefined: 1 })

  await assert.rejects(() =>
    uploadRange(client, handle.fd, {
      offset: 0,
      length: content.length,
      fileName: 'x',
      partSize: 512,
      retryOptions: { attempts: 1 },
    }),
  )

  await handle.close()
})

test('rejects a range that would need more than 4000 parts', async () => {
  const content = randomBytes(10)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  await assert.rejects(
    () => uploadRange(client, handle.fd, { offset: 0, length: 4001, fileName: 'x', partSize: 1 }),
    /4000 parts/,
  )
  await handle.close()
})

test('onProgress reports bytes sent and adds up to the right total', async () => {
  const content = randomBytes(2000)
  const { handle } = await tempFile(content)
  const client = fakeClient()
  const seen = []

  await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'x',
    partSize: 512,
    onProgress: (bytes) => seen.push(bytes),
  })

  assert.equal(seen.reduce((a, b) => a + b, 0), 2000)
  await handle.close()
})

test('a read error mid-batch produces no unhandledRejection that hides the real error', async () => {
  const content = randomBytes(2000)
  const { handle } = await tempFile(content)
  // Every request fails, so the already-pushed promises are guaranteed to reject
  // after the read loop breaks on reading past the end of the file.
  const client = fakeClient({ failEveryPart: true })

  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)

  try {
    await assert.rejects(
      () =>
        uploadRange(client, handle.fd, {
          offset: 0,
          // Ask for more bytes than the file holds: readExactly throws on the last part.
          length: 3000,
          fileName: 'x',
          partSize: 512,
          concurrency: 8,
          retryOptions: { attempts: 1 },
        }),
      /Short read/,
    )

    // Give the event loop a tick so any unhandledRejection has time to fire.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(unhandled, [], 'no promise may escape unhandled')
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await handle.close()
  }
})

// The mirror of the download path's stall guard. A part left on a sender that has stopped
// draining never resolves and never rejects, so without a deadline the batch's Promise.all
// waits forever, nothing is printed, and the upload ends when the event loop runs dry.
test('a part Telegram never acknowledges fails instead of waiting forever', async () => {
  const { handle } = await tempFile(randomBytes(1024))
  const client = { invoke: () => new Promise(() => {}) }

  await assert.rejects(
    () =>
      uploadRange(client, handle.fd, {
        offset: 0,
        length: 1024,
        fileName: 'stuck.bin',
        partSize: 512,
        concurrency: 2,
        stallMs: 20,
        retryOptions: { attempts: 2, baseDelayMs: 1 },
      }),
    /stopped acknowledging/,
  )

  await handle.close()
})

// `for (let start = 0; start < totalParts; start += concurrency)` never advances at zero.
// The explicit timeout is the point of the test: without the guard this spins forever, and a
// regression would hang the suite rather than fail it.
test('uploadRange refuses a worker count below one instead of spinning', { timeout: 5000 }, async () => {
  const { handle } = await tempFile(randomBytes(2000))

  for (const concurrency of [0, -1, 1.5, NaN]) {
    await assert.rejects(
      () =>
        uploadRange(fakeClient(), handle.fd, {
          offset: 0,
          length: 2000,
          fileName: 'x',
          partSize: 512,
          concurrency,
        }),
      /at least one|whole number/i,
      `concurrency ${concurrency} must not be accepted`,
    )
  }

  await handle.close()
})

// The hook encryption rides on. A transform that is never called would still pass every round
// trip, so this asserts what was sent, not what came back.
test('a transform sees each part in order, and what it returns is what is sent and hashed', async () => {
  const dir = await tempDir('uploader-transform')
  const file = path.join(dir, 'source.bin')
  const content = randomBytes(1000)
  await fs.writeFile(file, content)

  const client = fakeClient()
  const seen = []
  const flip = (bytes) => Buffer.from(bytes.map((byte) => byte ^ 0x5a))
  const handle = await fs.open(file, 'r')

  let result
  try {
    result = await uploadRange(client, handle.fd, {
      offset: 100,
      length: 700,
      fileName: 'x.part0001',
      partSize: 256,
      concurrency: 2,
      transform: (bytes, at) => {
        seen.push({ at, bytes: Buffer.from(bytes) })
        return flip(bytes)
      },
    })
  } finally {
    await handle.close()
  }

  assert.deepEqual(seen.map((part) => part.at), [0, 256, 512])
  assert.deepEqual(Buffer.concat(seen.map((part) => part.bytes)), content.subarray(100, 800))

  const expected = flip(content.subarray(100, 800))
  const sent = Buffer.concat(
    [...client.requests]
      .sort((a, b) => a.filePart - b.filePart)
      .map((request) => Buffer.from(request.bytes)),
  )

  assert.deepEqual(sent, expected)
  assert.equal(result.sha256, createHash('sha256').update(expected).digest('hex'))
})
