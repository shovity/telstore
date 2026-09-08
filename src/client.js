import { Api, TelegramClient } from 'teleproto'
import { Logger } from 'teleproto/extensions/index.js'
import { LogLevel } from 'teleproto/extensions/Logger.js'
import { returnBigInt } from 'teleproto/Helpers.js'
import { StringSession } from 'teleproto/sessions/index.js'

import { manifestFileName } from './manifest.js'
import { withRetry } from './retry.js'
import { assertLoggedIn, unlockConfig } from './session.js'
import { DEFAULT_STALL_MS, withStallTimeout } from './stall.js'

// teleproto narrates its version, every connection and every disconnect at info level, and
// those timestamped lines land in the middle of the progress bar. The client reads this
// logger before it prints anything, so LogLevel.NONE silences all of it; --verbose asks
// for the running commentary back when a connection needs diagnosing.
export function createLogger(verbose) {
  return new Logger(verbose ? LogLevel.INFO : LogLevel.NONE)
}

// The name Telegram shows under a document lives in an attribute, not on the message.
export function documentFileName(message) {
  const attributes = message?.media?.document?.attributes ?? []
  const named = attributes.find((a) => a instanceof Api.DocumentAttributeFilename)
  return named?.fileName ?? null
}

// Telegram records a document's length as a BigInteger, and comparing that to the plain
// number a manifest carries with === is false for every size there is.
export function documentSize(message) {
  const size = message?.media?.document?.size

  return size === undefined || size === null ? null : returnBigInt(size).toJSNumber()
}

// The flat shape both readers of a chat hand back. The raw message is kept alongside it
// because downloading needs it whole.
function toDocument(message) {
  return {
    id: message.id,
    fileName: documentFileName(message),
    caption: message.message ?? '',
    date: message.date,
    message,
  }
}

// The one place telstore searches a chat. Both callers want documents and nothing else,
// and getMessages is preferred over a raw Api.messages.Search because it handles offsets,
// hashes and pagination itself, so we don't hand-build easily mistyped fields. The raw
// message is kept alongside the flat fields because downloading needs it whole.
export async function searchDocuments(client, peer, { search, limit }) {
  const messages = await client.getMessages(peer, {
    search,
    filter: new Api.InputMessagesFilterDocument(),
    limit,
  })

  return messages.map(toDocument)
}

// What `list` reads the chat with. searchDocuments asks Telegram's text index a question;
// this asks for the documents themselves, newest first, which is the only answer that was
// right every time it was measured — a chat's text index can come back empty while the chat
// is full of backups, and did for a whole day in a channel that had just been created
// (docs/design/captions.md carries the measurements).
//
// The paging is ours rather than iterMessages', for the reasons deleteMessages does not use
// teleproto's: every page then carries the retry policy and the stall deadline, and a page
// that fails is retried by itself instead of restarting the walk from the newest message.
// offsetId is the id of the last message of the page before, and Telegram answers with the
// messages older than it — a walk that forgot to advance it would fetch the newest page over
// and over and never reach an older backup.
//
// A generator because the caller stops when it has what it wants: a chat of ten thousand
// chunks costs one request to list the backups at the top of it.
export const DOCUMENT_PAGE_SIZE = 100

export async function* iterDocuments(client, peer, options = {}) {
  const {
    pageSize = DOCUMENT_PAGE_SIZE,
    max = Infinity,
    retryOptions = {},
    stallMs = DEFAULT_STALL_MS,
  } = options

  let offsetId = 0
  let walked = 0

  while (walked < max) {
    const limit = Math.min(pageSize, max - walked)

    const messages = await withRetry(
      () =>
        withStallTimeout(
          client.getMessages(peer, {
            filter: new Api.InputMessagesFilterDocument(),
            limit,
            offsetId,
          }),
          stallMs,
          () =>
            `Telegram stopped answering while reading the documents older than message ` +
            `${offsetId}: nothing back for ${Math.round(stallMs / 1000)}s.`,
        ),
      retryOptions,
    )

    if (!messages || messages.length === 0) return

    for (const message of messages) yield toDocument(message)

    walked += messages.length
    offsetId = messages[messages.length - 1].id

    // A short page is the end of the chat. Asking again would cost a request to be told the
    // same thing.
    if (messages.length < limit) return
  }
}

// How telstore finds a backup's manifest, in one place because restore and delete must not
// disagree about it. The search is by backup id, but the answer is decided by the file name
// telstore itself wrote — a caption is text a person can edit, a file name is not.
export async function findManifestMessage(client, peer, backupId) {
  const wanted = manifestFileName(backupId)
  const found = await searchDocuments(client, peer, { search: backupId, limit: 100 })

  return found.find((doc) => doc.fileName === wanted)?.message ?? null
}

export async function readMessageBytes(client, message) {
  return await client.downloadMedia(message)
}

// The one place telstore removes messages from a chat, and the mirror of searchDocuments
// above. teleproto has its own deleteMessages, and it is the right thing to call — it resolves
// the peer and picks between channels.DeleteMessages and messages.DeleteMessages, which is
// exactly the choice a fake client would never catch us getting wrong.
//
// What it does on top of that is the problem: it splits the ids into batches of a hundred
// and fires every batch at once through Promise.all. A ten-thousand-chunk backup would put
// a hundred requests in flight together, none of them under the retry policy or the stall
// deadline that every other network wait in telstore carries. Batching here instead keeps
// one request outstanding at a time, under both.
//
// Telegram does not complain about an id that is no longer there, so sending a batch twice
// costs nothing: a delete interrupted halfway is finished by running it again.
//
// The hundred is Telegram's own limit on how many message ids one request may name, and it
// is the same limit whether the request removes them or asks about them — so getDocuments
// below counts in the same batches rather than keeping a second opinion about one number.
export const MESSAGE_BATCH_SIZE = 100

export async function deleteMessages(client, peer, ids, options = {}) {
  const {
    batchSize = MESSAGE_BATCH_SIZE,
    retryOptions = {},
    stallMs = DEFAULT_STALL_MS,
    onBatch,
  } = options

  let deleted = 0

  for (let start = 0; start < ids.length; start += batchSize) {
    const batch = ids.slice(start, start + batchSize)

    await withRetry(
      () =>
        // The options object is not optional: teleproto destructures `{ revoke }` with no
        // default of its own, so a two-argument call throws a TypeError before it ever
        // reaches the network. revoke is passed explicitly anyway — a backup has to go for
        // everyone who can see the chat, and that intent belongs in our code rather than in
        // a dependency's default.
        withStallTimeout(
          client.deleteMessages(peer, batch, { revoke: true }),
          stallMs,
          () =>
            `Telegram stopped answering while removing messages ${start + 1}-` +
            `${start + batch.length} of ${ids.length}: nothing back for ` +
            `${Math.round(stallMs / 1000)}s.`,
        ),
      retryOptions,
    )

    deleted += batch.length
    onBatch?.(deleted, ids.length)
  }

  return deleted
}

// What verify asks the chat, and the read-only mirror of deleteMessages above: our own
// batching, one request in flight at a time, under the same retry policy and the same stall
// deadline as every other network wait in telstore.
//
// The answer is a Map rather than a list because the question is "which of these are still
// there". Telegram reports a message that is gone as MessageEmpty — an object carrying the
// id it was asked about — so anything that is not a real message is left out here, where the
// shape is understood, rather than passed on to a caller that would read an empty as a chunk
// still sitting in the chat.
export async function getDocuments(client, peer, ids, options = {}) {
  const {
    batchSize = MESSAGE_BATCH_SIZE,
    retryOptions = {},
    stallMs = DEFAULT_STALL_MS,
    onBatch,
  } = options

  const found = new Map()

  for (let start = 0; start < ids.length; start += batchSize) {
    const batch = ids.slice(start, start + batchSize)

    const messages = await withRetry(
      () =>
        withStallTimeout(
          client.getMessages(peer, { ids: batch }),
          stallMs,
          () =>
            `Telegram stopped answering while looking up messages ${start + 1}-` +
            `${start + batch.length} of ${ids.length}: nothing back for ` +
            `${Math.round(stallMs / 1000)}s.`,
        ),
      retryOptions,
    )

    for (const message of messages ?? []) {
      if (!message || message instanceof Api.MessageEmpty) continue

      found.set(message.id, message)
    }

    onBatch?.(Math.min(start + batch.length, ids.length), ids.length)
  }

  return found
}

// Every command ends by putting the connection down, and a failure there must never
// swallow the real error already on its way up. Commands that print progress hand in an
// onWarn to say so; the quieter ones let it pass, because a connection that will not
// close cleanly says nothing about the work that already succeeded.
export async function closeQuietly(client, disconnect, onWarn) {
  try {
    await disconnect(client)
  } catch (err) {
    if (onWarn) onWarn(err)
  }
}

// Every command that needs Telegram comes through here, which makes this the one place a
// sealed session has to be opened. Doing it anywhere else would mean eight places to keep in
// step, and a ninth command would simply forget.
export async function connect(config, { verbose = false, unlock = unlockConfig } = {}) {
  assertLoggedIn(config)

  const { apiId, apiHash, session } = await unlock(config)

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: 60,
    baseLogger: createLogger(verbose),
  })

  await client.connect()

  if (!(await client.isUserAuthorized())) {
    throw new Error('Session expired — run "npx telstore login".')
  }

  return client
}
