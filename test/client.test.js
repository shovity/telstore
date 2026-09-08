import test from 'node:test'
import assert from 'node:assert/strict'

import { Api } from 'teleproto'
import { LogLevel } from 'teleproto/extensions/Logger.js'
import { returnBigInt } from 'teleproto/Helpers.js'

import {
  MESSAGE_BATCH_SIZE,
  createLogger,
  deleteMessages,
  documentSize,
  getDocuments,
} from '../src/client.js'

test('the Telegram logger is silent unless --verbose is given', () => {
  const quiet = createLogger(false)
  assert.equal(quiet.canSend(LogLevel.INFO), false)
  assert.equal(quiet.canSend(LogLevel.WARN), false)

  const loud = createLogger(true)
  assert.equal(loud.canSend(LogLevel.INFO), true)
  assert.equal(loud.canSend(LogLevel.WARN), true)
})

// teleproto's own deleteMessages splits the ids into batches of 100 and fires every batch at
// once through Promise.all. telstore batches them itself so exactly one request is in
// flight at a time, under the same retry and stall policy as every other network wait.
function recordingClient({ failTimes = 0, failAlways = false, hang = false } = {}) {
  const batches = []
  let inFlight = 0
  let maxInFlight = 0

  return {
    batches,
    maxInFlight: () => maxInFlight,
    async deleteMessages(peer, ids, options) {
      batches.push({ peer, ids, options })
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)

      try {
        if (hang) return await new Promise(() => {})
        await new Promise((resolve) => setImmediate(resolve))
        if (failAlways || batches.length <= failTimes) throw new Error('server said no')
        return [{ ptsCount: ids.length }]
      } finally {
        inFlight -= 1
      }
    },
  }
}

const ids = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i)

test('deleteMessages sends ids in batches of at most a hundred', async () => {
  const client = recordingClient()

  const removed = await deleteMessages(client, '@store', ids(250))

  assert.deepEqual(
    client.batches.map((b) => b.ids.length),
    [100, 100, 50],
  )
  assert.equal(removed, 250)
})

test('deleteMessages keeps one request in flight at a time', async () => {
  const client = recordingClient()

  await deleteMessages(client, '@store', ids(300))

  assert.equal(client.maxInFlight(), 1)
})

// teleproto destructures `{ revoke }` with no default of its own, so a two-argument call
// throws a TypeError before it reaches the network. revoke is passed explicitly anyway: a
// backup must go for everyone, and that intent belongs here rather than in a dependency.
test('deleteMessages asks Telegram to revoke, not just to hide locally', async () => {
  const client = recordingClient()

  await deleteMessages(client, '@store', [7])

  assert.deepEqual(client.batches[0].options, { revoke: true })
})

test('deleteMessages sends nothing at all for an empty list', async () => {
  const client = recordingClient()

  assert.equal(await deleteMessages(client, '@store', []), 0)
  assert.equal(client.batches.length, 0)
})

test('deleteMessages reports progress as each batch lands', async () => {
  const client = recordingClient()
  const seen = []

  await deleteMessages(client, '@store', ids(250), {
    onBatch: (done, total) => seen.push([done, total]),
  })

  assert.deepEqual(seen, [
    [100, 250],
    [200, 250],
    [250, 250],
  ])
})

test('deleteMessages retries a batch that failed once and carries on', async () => {
  const client = recordingClient({ failTimes: 1 })

  const removed = await deleteMessages(client, '@store', [1], {
    retryOptions: { attempts: 3, sleep: async () => {} },
  })

  assert.equal(removed, 1)
  assert.equal(client.batches.length, 2)
})

test('deleteMessages gives up loudly once the retries run out', async () => {
  const client = recordingClient({ failAlways: true })

  await assert.rejects(
    () =>
      deleteMessages(client, '@store', [1], {
        retryOptions: { attempts: 3, sleep: async () => {} },
      }),
    /server said no/,
  )
  assert.equal(client.batches.length, 3)
})

// A batch that fails takes the whole delete down with it: the batches after it are never
// sent, so nothing is removed past the point Telegram stopped cooperating.
test('deleteMessages stops at the batch that failed', async () => {
  const client = recordingClient({ failAlways: true })

  await assert.rejects(
    () =>
      deleteMessages(client, '@store', ids(250), {
        retryOptions: { attempts: 2, sleep: async () => {} },
      }),
    /server said no/,
  )

  assert.deepEqual(
    client.batches.map((b) => b.ids[0]),
    [1, 1],
  )
})

// A request the server accepts and never answers settles neither way. Without a deadline
// the delete would hold the process open forever and end without a word.
test('deleteMessages fails when Telegram stops answering instead of waiting forever', async () => {
  const client = recordingClient({ hang: true })

  await assert.rejects(
    () =>
      deleteMessages(client, '@store', ids(150), {
        stallMs: 5,
        retryOptions: { attempts: 1 },
      }),
    /nothing back for/,
  )
})

test('the batch size is the hundred Telegram accepts per request', () => {
  assert.equal(MESSAGE_BATCH_SIZE, 100)
})


// verify asks Telegram about a backup's chunk messages the same way delete removes them:
// our own batching, one request in flight, under the retry policy and the stall deadline.
// teleproto's getMessages would happily take ten thousand ids in one call and answer with
// whatever it felt like; the shape of the answer is the whole point of this function.
function messageClient({ empty = [], missing = [], hang = false, failTimes = 0 } = {}) {
  const calls = []
  let inFlight = 0
  let maxInFlight = 0

  return {
    calls,
    maxInFlight: () => maxInFlight,
    async getMessages(peer, params) {
      calls.push({ peer, params })
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)

      try {
        if (hang) return await new Promise(() => {})
        await new Promise((resolve) => setImmediate(resolve))
        if (calls.length <= failTimes) throw new Error('server said no')

        return params.ids
          .filter((id) => !missing.includes(id))
          .map((id) =>
            empty.includes(id)
              ? new Api.MessageEmpty({ id })
              : { id, media: { document: { size: returnBigInt(10) } } },
          )
      } finally {
        inFlight -= 1
      }
    },
  }
}

test('getDocuments asks for ids in batches of at most a hundred', async () => {
  const client = messageClient()

  const found = await getDocuments(client, '@store', ids(250))

  assert.deepEqual(
    client.calls.map((call) => call.params.ids.length),
    [100, 100, 50],
  )
  assert.equal(found.size, 250)
})

test('getDocuments keeps one request in flight at a time', async () => {
  const client = messageClient()

  await getDocuments(client, '@store', ids(300))

  assert.equal(client.maxInFlight(), 1)
})

// Telegram answers about a deleted message with MessageEmpty rather than leaving it out,
// and MessageEmpty carries the id it was asked about. Kept in the map it would read as a
// chunk that is still there, which is the one wrong answer this function must not give.
test('getDocuments leaves out a message Telegram reports as empty', async () => {
  const client = messageClient({ empty: [2] })

  const found = await getDocuments(client, '@store', [1, 2, 3])

  assert.deepEqual([...found.keys()], [1, 3])
})

test('getDocuments leaves out a message Telegram does not answer about at all', async () => {
  const client = messageClient({ missing: [2] })

  const found = await getDocuments(client, '@store', [1, 2, 3])

  assert.deepEqual([...found.keys()], [1, 3])
})

test('getDocuments asks for nothing at all when given no ids', async () => {
  const client = messageClient()

  assert.equal((await getDocuments(client, '@store', [])).size, 0)
  assert.equal(client.calls.length, 0)
})

test('getDocuments retries a batch that failed once and carries on', async () => {
  const client = messageClient({ failTimes: 1 })

  const found = await getDocuments(client, '@store', [1], {
    retryOptions: { attempts: 3, sleep: async () => {} },
  })

  assert.equal(found.size, 1)
  assert.equal(client.calls.length, 2)
})

test('getDocuments fails when Telegram stops answering instead of waiting forever', async () => {
  const client = messageClient({ hang: true })

  await assert.rejects(
    () => getDocuments(client, '@store', ids(150), { stallMs: 5, retryOptions: { attempts: 1 } }),
    /nothing back for/,
  )
})

// The size arrives as a BigInteger, and comparing that to a plain number from the manifest
// with === is false for every size there is.
test('documentSize reads the BigInteger teleproto puts on a document', () => {
  const message = { id: 1, media: { document: { size: returnBigInt('3221225472') } } }

  assert.equal(documentSize(message), 3221225472)
})

test('documentSize is null for a message carrying no document', () => {
  assert.equal(documentSize({ id: 1 }), null)
})
