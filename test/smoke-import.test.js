import test from 'node:test'
import assert from 'node:assert/strict'

import { Api, TelegramClient, errors } from 'teleproto'
import { StringSession } from 'teleproto/sessions/index.js'
import { readBigIntFromBuffer } from 'teleproto/Helpers.js'

import { withRetry } from '../src/retry.js'

test('the teleproto pieces we depend on can be imported', () => {
  assert.equal(typeof TelegramClient, 'function')
  assert.equal(typeof StringSession, 'function')
  assert.equal(typeof readBigIntFromBuffer, 'function')
  assert.equal(typeof Api.upload.SaveBigFilePart, 'function')
  assert.equal(typeof Api.InputFileBig, 'function')
})

// list and restore search the chat through these two, and the fake clients the rest of
// the suite talks to would happily accept a name teleproto does not have.
test('the teleproto pieces list and restore search with can be imported', () => {
  assert.equal(typeof Api.InputMessagesFilterDocument, 'function')
  assert.equal(typeof Api.DocumentAttributeFilename, 'function')
})

// delete hands ids to teleproto's own deleteMessages, which resolves the peer and picks
// between the two request types below. The fake client the rest of the suite talks to
// would accept a method name teleproto does not have.
test('the teleproto pieces delete removes messages with can be imported', () => {
  assert.equal(typeof TelegramClient.prototype.deleteMessages, 'function')
  assert.equal(typeof Api.messages.DeleteMessages, 'function')
  assert.equal(typeof Api.channels.DeleteMessages, 'function')
})

// Not decoration: teleproto destructures the third argument with no default of its own, so
// calling it with two arguments throws a TypeError before anything reaches the network.
// The arity is what says that object is required.
test('teleproto deleteMessages takes the options object telstore passes', () => {
  assert.equal(TelegramClient.prototype.deleteMessages.length, 3)
})

// test/retry.test.js builds its flood errors by hand, so it would keep passing if the real
// ones stopped looking like that. This is the one place the two are held together: the error
// comes out of teleproto's own RPCMessageToError, the same call MTProtoSender makes when the
// server answers with an error, and withRetry has to read the wait out of it.
test('withRetry waits out a real FLOOD_WAIT for the seconds the server named', async () => {
  const delays = []
  let calls = 0

  await withRetry(
    async () => {
      calls += 1
      if (calls === 1) {
        throw errors.RPCMessageToError(
          { errorCode: 420, errorMessage: 'FLOOD_WAIT_42' },
          new Api.upload.SaveBigFilePart({
            fileId: readBigIntFromBuffer(Buffer.alloc(8, 1), true, true),
            filePart: 0,
            fileTotalParts: 1,
            bytes: Buffer.alloc(0),
          }),
        )
      }
      return 'done'
    },
    { baseDelayMs: 100, sleep: async (ms) => { delays.push(ms) } },
  )

  assert.deepEqual(delays, [42000])
})

// verify decides a chunk is gone by what teleproto hands back for a deleted message, and
// MessageEmpty is the whole of that decision. A fake client would answer any shape at all.
test('the teleproto pieces verify reads a chat with can be imported', () => {
  assert.equal(typeof TelegramClient.prototype.getMessages, 'function')
  assert.equal(typeof Api.MessageEmpty, 'function')
})
