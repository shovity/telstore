import { promises as fs } from 'node:fs'

import { chatName, describeChat } from '../chat.js'
import {
  MESSAGE_BATCH_SIZE,
  closeQuietly,
  connect as realConnect,
  deleteMessages as realDeleteMessages,
  findManifestMessage,
  iterDocuments,
  readMessageBytes as realReadMessageBytes,
} from '../client.js'
import { askConfirm } from '../confirm.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import {
  backupIdDay,
  isChunkFileName,
  manifestFileName,
  manifestMessageIds,
  parseManifestJson,
} from '../manifest.js'
import { createWalkNotice, formatBytes, formatDuration, plural } from '../progress.js'
import { assertLoggedIn } from '../session.js'
import { requireChat, resolveSettings } from '../settings.js'
import { clearRestore, clearState, findRestores, findStates } from '../state.js'

// What list prints when a card cannot be read back. A manifest is text off a chat, and a
// summary is not worth inventing: the numbers below only decorate a decision the backup id
// has already settled.
const UNKNOWN = '—'

function describeName(name) {
  return typeof name === 'string' && name.trim() !== '' ? name : UNKNOWN
}

function describeSize(size) {
  return Number.isSafeInteger(size) && size >= 0 ? formatBytes(size) : UNKNOWN
}

// The same rule the manifest gets, for the same reason: a message id is the name of
// something about to be destroyed for good, so a record that cannot say it exactly is
// refused whole rather than half-obeyed. Sorted by chunk index so the batches — and the
// error naming a chunk — are the same on every run.
function stateMessageIds(record) {
  const done = record.state.done

  if (typeof done !== 'object' || done === null) {
    throw new Error(
      `The record of unfinished backup ${record.state.id} does not list the chunks it sent. ` +
        `${record.file} is damaged — delete that file by hand to drop the record, which ` +
        'leaves any chunks it did send sitting in the chat with nothing to point at them.',
    )
  }

  return Object.entries(done)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([index, entry]) => {
      const msgId = entry?.msgId

      if (!Number.isSafeInteger(msgId) || msgId < 1) {
        throw new Error(
          `The record of unfinished backup ${record.state.id} gives ` +
            `${JSON.stringify(msgId)} as the message id of chunk ${Number(index) + 1}, which ` +
            `is not a message id. ${record.file} is damaged, so telstore is not deleting ` +
            'anything.',
        )
      }

      return msgId
    })
}

// The manifest a stream upload left in the chat when its rollback could not finish.
// `searchManifest` is how delete normally finds a manifest, and it asks Telegram's text
// index — the one docs/design/captions.md records returning nothing for a channel whose
// documents were all plainly there, with nothing that predicts when that happens. A stream
// run writes the id of the card it sent into its record before that record can be left
// behind, so when the index comes up empty the record still names it. Without this, delete
// would take the chunks away and leave the manifest advertising a backup restore cannot
// fulfil, and nothing on this machine could ever find it again.
//
// Deliberately not folded into stateMessageIds: the manifest is the only index of the ids
// under it, so it goes last (docs/design/delete.md), and counting it among them would make
// the report say "2 chunk messages" for one chunk and a card.
function stateManifestId(record) {
  const msgId = record.state.manifestMsgId

  if (msgId === undefined || msgId === null) return null

  // The same rule the chunk ids get, for the same reason: a message id names something about
  // to be destroyed for good, so a record that cannot say it exactly is refused whole.
  if (!Number.isSafeInteger(msgId) || msgId < 1) {
    throw new Error(
      `The record of unfinished backup ${record.state.id} gives ${JSON.stringify(msgId)} as ` +
        `the message id of its manifest, which is not a message id. ${record.file} is ` +
        'damaged, so telstore is not deleting anything.',
    )
  }

  return msgId
}

// How far back the walk below reads before it stops without having proved it reached the
// start of the backup. It has to clear a whole backup and then some: MAX_CHUNKS chunks with
// the manifest over them is 10,001 documents of telstore's own, and a chat holds whatever
// else its owner put there in between. `list` has a ceiling for the same job and it is
// exactly 10,000, which would stop this walk one document short of the largest backup
// telstore makes — so this is its own number rather than that one borrowed.
export const MAX_DELETE_DOCUMENTS = 20000

// The slack under the day the backup id carries, and it is subtracted rather than added: the
// floor has to sit *below* everything this backup could have sent, and a floor one day too
// high stops the walk early, sets `complete`, and prints "Done" over documents nobody read.
// That day comes from the clock of the machine that made the backup and a document's date
// comes from Telegram's, and the two need not agree; a day is far more than a skew anybody
// would leave unnoticed, since a machine a day out dates every backup wrongly in `list`. The
// cost is one extra day of documents read.
const DAY_SECONDS = 86400

// What the manifest and the local record between them cannot promise: everything of this
// backup that is actually in the chat. Measured 2026-09-09 against a real account, a stream
// upload left by a second Ctrl-C put a chunk in the chat that its own record never named
// (docs/design/data-integrity.md), and the `delete` that run printed then reported the backup
// removed with 12MB of it still sitting there. Every chunk carries the backup id in the file
// name telstore wrote, so the chat can be asked instead of taken on trust.
//
// Newest first, and it stops only where *every* floor it has agrees that there is nothing of
// this backup further down. There are two, and neither is trusted to be right on its own:
//
//   - The oldest message id the backup is known to have sent. telstore sends chunk 0 first
//     and records each id as it lands, so the ids it knows are a prefix of the ids it sent
//     and the smallest is the backup's first message. That argument holds for records and
//     manifests telstore wrote; it does not hold for the hand-edited ones both of them are,
//     and a record with chunk 0 taken out of it raises this floor over chunks that are
//     really there.
//   - The day the backup id carries, less a day. Derived from the id the user typed rather
//     than from any file, so a doctored record cannot move it — but it is the uploading
//     machine's clock against Telegram's, which is the reason for the slack.
//
// Requiring both is what makes each one's blind spot somebody else's problem: an id floor
// lifted by an edited record is held down by the date, and a date floor lifted by a wrong
// clock is held down by the id. It costs one extra day of documents, and the alternative is
// a walk that stops early and then says "Done", which is the failure this exists to remove.
// Where only one floor exists it decides alone, and where neither does the budget is all
// there is.
//
// Chunks found do not lower the floor. It is tempting, and it is how a walk with no floor at
// all quietly stops early: a chunk deleted by hand out of the middle breaks the chain, and
// the next document down is below the last one found rather than above it.
async function findChunksInChat(client, chat, backupId, options) {
  const {
    known,
    readDocuments,
    retryOptions,
    offsetId,
    max = MAX_DELETE_DOCUMENTS,
    onRead,
  } = options

  let floorId = null

  for (const id of known) floorId = floorId === null ? id : Math.min(floorId, id)

  const day = backupIdDay(backupId)
  const floorDate = day === null ? null : day - DAY_SECONDS

  const floors = []

  if (floorId !== null) floors.push((document) => document.id <= floorId)
  if (floorDate !== null) floors.push((document) => document.date < floorDate)

  const chunks = []
  let manifest = null
  let read = 0
  let reachedFloor = false

  for await (const document of readDocuments(client, chat, { max, offsetId, retryOptions })) {
    read += 1
    onRead?.(read, chunks.length)

    // Every chunk of this backup, not only the ones nothing names yet. Which of them are
    // leftovers is not a question this loop can answer: the card that names them may still
    // be several documents below, and the caller works it out once it has read that.
    if (isChunkFileName(backupId, document.fileName)) {
      chunks.push(document.id)
    } else if (manifest === null && document.fileName === manifestFileName(backupId)) {
      // The same rule findManifestMessage keeps, reached without the text index: a document
      // named <id>.manifest.json is this backup's card. Only used when the search came back
      // with nothing, and docs/design/captions.md is the record of how often that happens.
      //
      // The raw message, not the flat document around it — the same thing findManifestMessage
      // hands back, because both of them feed readMessageBytes and teleproto's downloadMedia
      // takes an Api.Message or treats its argument as media and throws "Cannot download media
      // of type object". One shape for one job, so the next reader cannot pick the wrong half.
      manifest = document.message
    }

    if (floors.length > 0 && floors.every((below) => below(document))) {
      reachedFloor = true
      break
    }
  }

  // Two other ways a walk ends knowing it saw everything: it reached a floor, or the chat ran
  // out of documents before the budget did. A walk stopped by the budget alone is the only
  // one that cannot say what is behind it, and this is the flag that stops the report saying
  // "Done" over a removal nothing proved was complete.
  return { chunks, manifest, read, complete: reachedFloor || read < max }
}

// A file record is keyed on a path; a stream record has none, because its bytes came from a
// command's stdout, and carries the name the backup was given instead. Reading only the path
// describes a backup whose name is sitting right there in the record as the placeholder for
// something nothing could say.
function describeRecord(state) {
  return describeName(state?.name ?? state?.path)
}

// One sentence for one fact, said once before the question and once in the report. Neither
// alarm nor a footnote: a chunk in the chat that nothing on this machine names is exactly
// what this walk was added to find, and reading the chat is how it was found.
function strayChunks(count) {
  return (
    `${plural(count, 'chunk message')} of this backup that no manifest and no record on ` +
    'this machine names'
  )
}

export async function runDelete(backupId, options = {}, deps = {}) {
  const {
    connect = realConnect,
    disconnect = (client) => client.destroy(),
    configDir = defaultConfigDir(),
    searchManifest = findManifestMessage,
    readDocuments = iterDocuments,
    // Through deps rather than read straight off the constant, for the reason runStreamUpload
    // takes maxChunks that way: a ceiling twenty thousand documents up is a ceiling no test
    // will ever reach, and the wording it changes is the one that must not say "Done".
    maxDocuments = MAX_DELETE_DOCUMENTS,
    readMessageBytes = realReadMessageBytes,
    deleteMessages = realDeleteMessages,
    confirm = askConfirm,
    retryOptions = {},
    writeErr = (line) => process.stderr.write(line),
    log: writeLog = (line) => console.log(line),
    // The walk's notice goes to stderr and only onto a terminal, the same as `list`'s: a
    // carriage return in a log file is rubbish, and delete is a command scripts run.
    writeProgress = process.stderr.isTTY ? (text) => process.stderr.write(text) : null,
    now = () => Date.now(),
    silent = false,
  } = deps

  const config = await loadConfig(configDir)
  const { values: settings } = resolveSettings(options, config, { file: configFile(configDir) })
  // Before requireChat, as in list: telling somebody who has never logged in to go and pick
  // a destination sends them after the wrong thing.
  assertLoggedIn(config)
  const chat = requireChat(settings)

  const log = silent ? () => {} : writeLog
  const warn = silent ? () => {} : writeErr

  // Upload and restore stay quiet until the third retry so a handful of -503s do not bury
  // the progress bar. There is no bar here to bury, and a wait in the middle of destroying
  // somebody's backup is always worth saying out loud — so this one announces from the first.
  function onRetry(err, attempt, delayMs) {
    warn(
      `\nTemporary error (${err.message}), retry ${attempt} in ` +
        `${formatDuration(delayMs / 1000)}.\n`,
    )
  }

  // A local lookup that refuses should not cost a connection first.
  const records = await findStates(backupId, configDir)

  if (records.length > 1) {
    throw new Error(
      `Two local records both claim to be backup ${backupId}: ` +
        `${records.map((r) => r.file).join(' and ')}. telstore will not guess which one to ` +
        'drop — remove the wrong one by hand and run again.',
    )
  }

  const record = records[0] ?? null
  const client = await connect(config, { verbose: settings.verbose })

  try {
    const searched = await searchManifest(client, chat, backupId)

    let manifestMessage = searched
    let manifest = null
    const ids = new Set()

    // Reading one message's manifest into the set of ids about to be destroyed. Two callers
    // now: the card Telegram's search index handed over, and the card the walk below met on
    // its way down when that index had nothing to say.
    async function readManifest(message) {
      const parsed = parseManifestJson(await readMessageBytes(client, message))

      // The manifest was found by the file name telstore itself wrote, and that name is the
      // id this command was asked about. A body naming a different backup is a file that was
      // renamed or replaced, and its message ids point at somebody else's chunks — the one
      // mistake in this whole command that nothing can undo.
      if (parsed?.id !== undefined && parsed.id !== backupId) {
        throw new Error(
          `The manifest named ${manifestFileName(backupId)} describes backup ` +
            `${JSON.stringify(parsed.id)}, not ${backupId}. Its message ids point at ` +
            'another backup\'s chunks, so telstore is not deleting anything.',
        )
      }

      for (const id of manifestMessageIds(parsed)) ids.add(id)

      return parsed
    }

    if (manifestMessage) manifest = await readManifest(manifestMessage)

    // Both sources describe the same backup, so an id in either is a message this backup put
    // in the chat. In practice the record holds nothing the manifest does not — but it is a
    // file on disk that a truncated write or a hand edit can mangle, and an id left out here
    // is a chunk that nothing can point at ever again.
    if (record) {
      for (const id of stateMessageIds(record)) ids.add(id)
    }

    // And now the chat's own answer, because neither of those two is a list of what is there.
    // The walk starts under the card when the search found one — a backup's manifest is the
    // last message its run sends, so nothing of it is newer, and everything posted since is
    // read for nothing. With no card it starts at the newest message in the chat, which is
    // exactly where the chunk a "leave now" left behind will be.
    const notice =
      writeProgress && !silent ? createWalkNotice({ write: writeProgress, now }) : null

    let walk

    try {
      walk = await findChunksInChat(client, chat, backupId, {
        known: ids,
        readDocuments,
        retryOptions,
        offsetId: searched?.id ?? 0,
        max: maxDocuments,
        onRead: (read, seen) =>
          notice?.tick(
            `Reading ${chatName(chat)}… ${read} documents, ` +
              `${plural(seen, 'chunk')} of this backup`,
          ),
      })
    } finally {
      notice?.clear()
    }

    if (!manifestMessage && walk.manifest) {
      manifestMessage = walk.manifest
      manifest = await readManifest(manifestMessage)
    }

    // Counted after the walk's own manifest has had its say, or a card the search missed
    // would have every one of its chunks reported as a message nothing names.
    const strays = walk.chunks.filter((id) => !ids.has(id))

    for (const id of strays) ids.add(id)

    if (!manifestMessage && !record && ids.size === 0) {
      throw new Error(
        `No backup ${backupId} found in ${chatName(chat)}` +
          (walk.complete ? '' : ` — the newest ${walk.read} documents were read`) +
          ', and no unfinished record of it on this machine. Check the id with ' +
          '"npx telstore list", or use --chat to point at the right chat.',
      )
    }

    // Sorted for the reason stateMessageIds sorts by chunk index, now that a third source
    // feeds this set: a message id climbs with the chunk it carries, so ascending is the
    // order this backup was sent in and the order the report's "removed 3 of 5" counts in.
    // Insertion order is not that — the walk hands its chunks over newest first, and a stray
    // older than everything the record names would otherwise go out in the middle.
    const chunkIds = [...ids].sort((a, b) => a - b)

    // Where this backup's manifest is, if anywhere. The chat's own answer wins over the
    // record's, the way it does for the chunk ids above: the record is a file on disk that a
    // hand edit can mangle, and the message the search returned is one telstore just looked at.
    const manifestId = manifestMessage?.id ?? (record ? stateManifestId(record) : null)

    if (manifest) {
      log(`Backup ${backupId}`)
      log(
        `File   ${describeName(manifest.name)} ` +
          `(${describeSize(manifest.size)}, ${plural(manifest.chunks.length, 'chunk')})`,
      )
    } else {
      // "no manifest in the chat" is a claim, and the record can contradict it: a search that
      // returned nothing is not the same fact as a manifest that was never sent.
      log(
        `Backup ${backupId} (unfinished — ` +
          (manifestId === null
            ? 'no manifest in the chat)'
            : 'its record names a manifest the chat search did not return)'),
      )
      log(`File   ${record ? describeRecord(record.state) : UNKNOWN}`)
    }

    log(`From   ${describeChat(chat)}`)

    // Said before the question that authorises the removal, not only after it: the count in
    // that question already includes these, and a number a person is agreeing to has to be
    // one they can account for.
    if (strays.length > 0) {
      log(`Also   ${strayChunks(strays.length)}, found by reading ${chatName(chat)}`)
    }

    log('')

    const prompt = manifest
      ? `Delete this backup from ${chatName(chat)}? The chunks cannot be recovered. [y/N] `
      : `Delete the ${plural(chunkIds.length, 'chunk message')} it sent` +
        `${manifestId === null ? '' : ', the manifest it named'}` +
        // Only when there is one. Nothing on this machine names the chunks a walk found on
        // its own, and a question that offers to drop a record that does not exist is one
        // whose answer means something other than what it says.
        `${record ? ', and its local record' : ''}? The chunks cannot be recovered. [y/N] `

    if (!options.yes && !(await confirm(prompt))) {
      throw new Error('Cancelled on request.')
    }

    const loud = chunkIds.length > MESSAGE_BATCH_SIZE
    let removed = 0

    try {
      await deleteMessages(client, chat, chunkIds, {
        retryOptions: { ...retryOptions, onRetry },
        onBatch: (done, total) => {
          removed = done
          if (loud) warn(`\rRemoving chunk messages ${done}/${total}…`)
        },
      })
    } catch (err) {
      throw new Error(
        `Removed ${removed} of ${plural(chunkIds.length, 'chunk message')} of ${backupId}, ` +
          `then Telegram refused: ${err.message}. ` +
          // What is still standing that can name the rest, and nothing else. Where the walk
          // of the chat is the only thing that found these there is no such list on this
          // machine at all, and saying a record was kept when there is none sends somebody
          // looking through ~/.telstore for a file that was never written.
          (manifestMessage
            ? 'The manifest was left in place on purpose — it is the only list of the ' +
              'messages that are still there. '
            : record
              ? 'The local record was left in place on purpose — it is the only list of the ' +
                'messages that are still there. '
              : `Nothing on this machine names the rest: reading ${chatName(chat)} for ` +
                `${backupId} is what found them, which is what running this again does. `) +
          'Run the same command again to finish.',
      )
    }

    if (loud) warn('\n')

    // Only now. The manifest is the only index of the ids above, and where there is no
    // manifest the local record is. Anything that throws before this line leaves the way
    // back intact, and running delete again picks up where this run stopped.
    if (manifestId !== null) {
      try {
        await deleteMessages(client, chat, [manifestId], {
          retryOptions: { ...retryOptions, onRetry },
        })
      } catch (err) {
        throw new Error(
          `Removed every chunk message of ${backupId}, but Telegram refused to remove its ` +
            `manifest: ${err.message}. Run the same command again to finish.`,
        )
      }
    }

    if (record) await clearState(record.key, configDir)

    // The chunks are gone from the chat, so a restore record pointing at this backup now
    // names messages nobody can fetch: `status` would keep offering a resume command that
    // can only fail. Dropped here rather than earlier for the same reason the upload record
    // is — anything that throws above leaves the way back intact.
    //
    // The .partial itself stays. It is the user's data, sometimes gigabytes of it, and this
    // command removes what was asked for and nothing else. But it can never be completed
    // now, so it is named on the way out: that is the difference between a file they can
    // reclaim and one they will never think to look for.
    const stranded = []

    for (const found of await findRestores(backupId, configDir)) {
      await clearRestore(found.key, configDir)

      const partial = `${found.record.target}.partial`

      try {
        await fs.stat(partial)
        stranded.push(partial)
      } catch {
        // Nothing there to tell them about.
      }
    }

    // "Done" is a claim that there is nothing of this backup left, and only a walk that
    // reached a floor it can prove has earned it. One stopped by its own budget removed
    // everything it found and cannot say what is behind it, so it says that instead.
    const lead = walk.complete ? 'Done. Removed' : 'Removed'

    if (manifestId !== null) {
      log(
        `\n${lead} ${backupId} from ${chatName(chat)}: ` +
          `${plural(chunkIds.length, 'chunk message')} and its manifest.`,
      )
      if (record) log('The local record of this backup was removed too.')
    } else if (record) {
      log(
        `\n${lead} ${plural(chunkIds.length, 'chunk message')} from ${chatName(chat)} ` +
          `and dropped the local record of ${backupId}.`,
      )
    } else {
      // Nothing on this machine ever named these: the chat is where they were found and the
      // chat is all there was to drop.
      log(
        `\n${lead} ${plural(chunkIds.length, 'chunk message')} of ${backupId} from ` +
          `${chatName(chat)}.`,
      )
    }

    if (strays.length > 0) {
      log(`That includes ${strayChunks(strays.length)}, found by reading ${chatName(chat)}.`)
    }

    if (!walk.complete) {
      log(
        `telstore read the newest ${walk.read} documents of ${chatName(chat)} without ` +
          'reaching the start of this backup, so it cannot say that was all of it. Anything ' +
          `of ${backupId} still there carries that id in its file name, which is what ` +
          "Telegram's own search reads.",
      )
    }

    for (const partial of stranded) {
      log(
        `${partial} is a half-finished restore of this backup. Nothing can finish it now — ` +
          'delete it when you want the space back.',
      )
    }

    return {
      id: backupId,
      chunks: chunkIds.length,
      manifestDeleted: manifestId !== null,
      stateCleared: Boolean(record),
      // What the walk of the chat added, and whether it got far enough to say that was all
      // of it. A batch prints one line per id and these are the two things that line would
      // otherwise leave out.
      strays: strays.length,
      complete: walk.complete,
    }
  } finally {
    await closeQuietly(client, disconnect, (err) =>
      warn(`\nWarning: could not close the Telegram connection: ${err.message}\n`),
    )
  }
}


// `telstore delete a b c` is three deletes, and the question that guards them is asked once —
// which means it has to be able to say what all three are. So the batch looks every id up
// before it asks: the manifest for the finished ones, the local record for the unfinished, and
// an id that neither knows about refuses the whole run rather than half of it. runDelete then
// does exactly what it does alone, having already been told the answer.
export async function runDeletes(backupIds, options = {}, deps = {}) {
  const {
    connect = realConnect,
    disconnect = (client) => client.destroy(),
    configDir = defaultConfigDir(),
    searchManifest = findManifestMessage,
    readMessageBytes = realReadMessageBytes,
    confirm = askConfirm,
    interactive = () => Boolean(process.stdin.isTTY),
    writeErr = (line) => process.stderr.write(line),
    log: writeLog = (line) => console.log(line),
    silent = false,
  } = deps

  // One id keeps its own wording, its own question and its own thrown error.
  if (backupIds.length === 1) {
    const result = await runDelete(backupIds[0], options, deps)
    return { results: [result], failed: 0 }
  }

  const duplicate = backupIds.find((id, index) => backupIds.indexOf(id) !== index)

  if (duplicate) {
    throw new Error(
      `${duplicate} is named twice. Deleting one backup twice does nothing the first pass ` +
        'did not already do — name it once.',
    )
  }

  const config = await loadConfig(configDir)

  assertLoggedIn(config)

  const { values: settings } = resolveSettings(options, config, { file: configFile(configDir) })
  const chat = requireChat(settings)

  const log = silent ? () => {} : writeLog
  const warn = silent ? () => {} : writeErr

  let shared = null
  const perId = {
    ...deps,
    connect: async (theirConfig, connectOptions) =>
      (shared ??= await connect(theirConfig, connectOptions)),
    disconnect: async () => {},
  }

  const results = []

  try {
    const client = await perId.connect(config, { verbose: settings.verbose })
    const rows = []
    const unknown = []

    for (const backupId of backupIds) {
      const message = await searchManifest(client, chat, backupId)
      const records = await findStates(backupId, configDir)

      if (!message && records.length === 0) {
        unknown.push(backupId)
        continue
      }

      // A manifest too damaged to read is exactly the backup somebody is here to remove, so
      // it costs the row its name and size, not the run. runDelete refuses the ones that
      // cannot name their message ids, which is the check that actually protects anything.
      let manifest = null

      if (message) {
        try {
          manifest = parseManifestJson(await readMessageBytes(client, message))
        } catch {
          manifest = null
        }
      }

      rows.push({ id: backupId, manifest, record: records[0] ?? null })
    }

    if (unknown.length > 0) {
      // "No manifest for it", not "not found": a single delete walks the chat for chunks
      // carrying the id, and finds them where nothing on this machine names them. A batch does
      // not, because this question is asked about every id at once and before anything is
      // destroyed, and a walk apiece would turn one mistyped id into minutes of reading
      // somebody's archive. Saying which is which is what keeps the sentence true.
      throw new Error(
        `Nothing was deleted: ${unknown.join(', ')} — no manifest for it in ` +
          `${chatName(chat)}, and no local record of it on this machine either. Check the ids ` +
          'with "npx telstore list". Deleting one id on its own also reads the chat for ' +
          'chunks nothing names; a batch does not.',
      )
    }

    if (!options.yes) {
      if (!interactive()) {
        throw new Error(
          `${backupIds.length} backups to delete, and no terminal to confirm that in. Run ` +
            'again with --yes to delete them without being asked.',
        )
      }

      for (const line of listingLines(rows, chat)) log(line)

      if (
        !(await confirm(
          `The chunks cannot be recovered. Delete all ${backupIds.length}? [y/N] `,
        ))
      ) {
        throw new Error('Cancelled on request.')
      }
    }

    for (const [index, backupId] of backupIds.entries()) {
      if (index > 0) log('')
      log(`[${index + 1}/${backupIds.length}] ${backupId}`)

      try {
        // The question was asked about the whole list a moment ago; asking again per backup
        // would be asking the same thing three times.
        results.push(await runDelete(backupId, { ...options, yes: true }, perId))
      } catch (err) {
        results.push({ id: backupId, error: err.message })
        warn(`\n${backupId} failed: ${err.message}\n`)
      }
    }
  } finally {
    if (shared) {
      await closeQuietly(shared, disconnect, (err) =>
        warn(`\nWarning: could not close the Telegram connection: ${err.message}\n`),
      )
    }
  }

  const failed = results.filter((result) => result.error).length

  log('')
  for (const line of summaryLines(results, failed)) log(line)

  return { results, failed }
}

// What is about to be destroyed, spelled out before the one question that authorises it. An
// unfinished backup has no manifest to describe it, so its own record speaks for it.
function listingLines(rows, chat) {
  const described = rows.map(({ id, manifest, record }) => ({
    id,
    name: manifest
      ? describeName(manifest.name)
      : `${describeRecord(record?.state)} (unfinished)`,
    size: manifest ? describeSize(manifest.size) : UNKNOWN,
    chunks: plural(countChunks(manifest, record), 'chunk'),
  }))

  const width = (key) => Math.max(...described.map((row) => row[key].length))
  const [idWidth, nameWidth, sizeWidth] = [width('id'), width('name'), width('size')]

  return [
    `Deleting ${rows.length} backups from ${describeChat(chat)}`,
    '',
    ...described.map(
      (row) =>
        `  ${row.id.padEnd(idWidth)}  ${row.name.padEnd(nameWidth)}  ` +
        `${row.size.padStart(sizeWidth)}  ${row.chunks}`,
    ),
    '',
  ]
}

function countChunks(manifest, record) {
  if (Array.isArray(manifest?.chunks)) return manifest.chunks.length

  const done = record?.state?.done

  return typeof done === 'object' && done !== null ? Object.keys(done).length : 0
}

// Every id gets a line whether it worked or not: one missing from this list would be a backup
// nobody could tell the fate of.
function summaryLines(results, failed) {
  const width = Math.max(...results.map((result) => result.id.length))
  const deleted = results.length - failed

  return [
    `${results.length} backups: ${deleted} deleted, ${failed} failed.`,
    '',
    ...results.map((result) => {
      const id = result.id.padEnd(width)

      if (result.error) return `  ${id}  failed: ${result.error}`

      return (
        `  ${id}  ${plural(result.chunks, 'chunk message')} removed` +
        (result.manifestDeleted ? ' with its manifest' : '') +
        (result.strays > 0 ? `, ${result.strays} of them named by nothing on this machine` : '') +
        (result.complete ? '' : ' — telstore could not read far enough back to say that was all')
      )
    }),
  ]
}
