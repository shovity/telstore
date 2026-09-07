import { promises as fs } from 'node:fs'

import { chatName, describeChat } from '../chat.js'
import {
  DELETE_BATCH_SIZE,
  closeQuietly,
  connect as realConnect,
  deleteMessages as realDeleteMessages,
  findManifestMessage,
  readMessageBytes as realReadMessageBytes,
} from '../client.js'
import { askConfirm } from '../confirm.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import { manifestFileName, manifestMessageIds, parseManifestJson } from '../manifest.js'
import { formatBytes, formatDuration } from '../progress.js'
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

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
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

export async function runDelete(backupId, options = {}, deps = {}) {
  const {
    connect = realConnect,
    disconnect = (client) => client.destroy(),
    configDir = defaultConfigDir(),
    searchManifest = findManifestMessage,
    readMessageBytes = realReadMessageBytes,
    deleteMessages = realDeleteMessages,
    confirm = askConfirm,
    retryOptions = {},
    writeErr = (line) => process.stderr.write(line),
    log: writeLog = (line) => console.log(line),
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
    const manifestMessage = await searchManifest(client, chat, backupId)

    if (!manifestMessage && !record) {
      throw new Error(
        `No backup ${backupId} found in ${chatName(chat)}, and no unfinished record of it on ` +
          'this machine. Check the id with "npx telstore list", or use --chat to point at the ' +
          'right chat.',
      )
    }

    let manifest = null
    const ids = new Set()

    if (manifestMessage) {
      manifest = parseManifestJson(await readMessageBytes(client, manifestMessage))

      // The manifest was found by the file name telstore itself wrote, and that name is the
      // id this command was asked about. A body naming a different backup is a file that was
      // renamed or replaced, and its message ids point at somebody else's chunks — the one
      // mistake in this whole command that nothing can undo.
      if (manifest?.id !== undefined && manifest.id !== backupId) {
        throw new Error(
          `The manifest named ${manifestFileName(backupId)} describes backup ` +
            `${JSON.stringify(manifest.id)}, not ${backupId}. Its message ids point at ` +
            'another backup\'s chunks, so telstore is not deleting anything.',
        )
      }

      for (const id of manifestMessageIds(manifest)) ids.add(id)
    }

    // Both sources describe the same backup, so an id in either is a message this backup put
    // in the chat. In practice the record holds nothing the manifest does not — but it is a
    // file on disk that a truncated write or a hand edit can mangle, and an id left out here
    // is a chunk that nothing can point at ever again.
    if (record) {
      for (const id of stateMessageIds(record)) ids.add(id)
    }

    const chunkIds = [...ids]

    if (manifest) {
      log(`Backup ${backupId}`)
      log(
        `File   ${describeName(manifest.name)} ` +
          `(${describeSize(manifest.size)}, ${plural(manifest.chunks.length, 'chunk')})`,
      )
    } else {
      log(`Backup ${backupId} (unfinished — no manifest in the chat)`)
      log(`File   ${describeName(record.state.path)}`)
    }

    log(`From   ${describeChat(chat)}`)
    log('')

    const prompt = manifest
      ? `Delete this backup from ${chatName(chat)}? The chunks cannot be recovered. [y/N] `
      : `Delete the ${plural(chunkIds.length, 'chunk message')} it sent, and its local ` +
        `record? The chunks cannot be recovered. [y/N] `

    if (!options.yes && !(await confirm(prompt))) {
      throw new Error('Cancelled on request.')
    }

    const loud = chunkIds.length > DELETE_BATCH_SIZE
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
          (manifestMessage
            ? 'The manifest was left in place on purpose — it is the only list of the ' +
              'messages that are still there. '
            : 'The local record was left in place on purpose — it is the only list of the ' +
              'messages that are still there. ') +
          'Run the same command again to finish.',
      )
    }

    if (loud) warn('\n')

    // Only now. The manifest is the only index of the ids above, and where there is no
    // manifest the local record is. Anything that throws before this line leaves the way
    // back intact, and running delete again picks up where this run stopped.
    if (manifestMessage) {
      try {
        await deleteMessages(client, chat, [manifestMessage.id], {
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

    if (manifestMessage) {
      log(
        `\nDone. Removed ${backupId} from ${chatName(chat)}: ` +
          `${plural(chunkIds.length, 'chunk message')} and its manifest.`,
      )
      if (record) log('The local record of this backup was removed too.')
    } else {
      log(
        `\nDone. Removed ${plural(chunkIds.length, 'chunk message')} from ${chatName(chat)} ` +
          `and dropped the local record of ${backupId}.`,
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
      manifestDeleted: Boolean(manifestMessage),
      stateCleared: Boolean(record),
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
      throw new Error(
        `Nothing was deleted: ${unknown.join(', ')} — not found in ${chatName(chat)}, and no ` +
          'local record of it on this machine either. Check the ids with "npx telstore list".',
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
      : `${describeName(record?.state?.path)} (unfinished)`,
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

      return result.error
        ? `  ${id}  failed: ${result.error}`
        : `  ${id}  ${plural(result.chunks, 'chunk message')} removed` +
            (result.manifestDeleted ? ' with its manifest' : '')
    }),
  ]
}
