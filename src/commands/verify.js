import { chatName, describeChat } from '../chat.js'
import {
  MESSAGE_BATCH_SIZE,
  closeQuietly,
  connect as realConnect,
  documentFileName,
  documentSize,
  findManifestMessage,
  getDocuments as realGetDocuments,
  readMessageBytes as realReadMessageBytes,
} from '../client.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import { chunkFileName, manifestFileName, parseManifest } from '../manifest.js'
import { formatBytes, formatDuration, plural } from '../progress.js'
import { assertLoggedIn } from '../session.js'
import { requireChat, resolveSettings } from '../settings.js'

// parseManifest guarantees every number in a manifest, but not the file name — it is
// decoration, and nothing verifies differently because of it. It is still text off a chat.
function describeName(name) {
  return typeof name === 'string' && name.trim() !== '' ? name : '—'
}

// What is wrong with one chunk, or null when nothing is. The first failing check wins: a
// chunk is damaged or it is not, and listing three complaints about one message would make
// "2 damaged" mean something other than two chunks.
//
// Every question here is one the chat can answer without sending a byte of the file. What
// this cannot ask is whether the bytes inside are the bytes that went up — only downloading
// them answers that, which is why the closing line says so rather than leaving it implied.
function inspect(chunk, message, { backupId, total, chat }) {
  const at = `Chunk ${chunk.i + 1}/${total}`

  if (!message) {
    return `${at} is gone: message ${chunk.msgId} is no longer in ${chatName(chat)}.`
  }

  const size = documentSize(message)

  if (size === null) {
    return `${at} is message ${chunk.msgId}, which has no file attached.`
  }

  const wanted = chunkFileName(backupId, chunk.i)
  const fileName = documentFileName(message)

  if (fileName !== wanted) {
    return fileName === null
      ? `${at} is message ${chunk.msgId}, whose file carries no name; the manifest expects ` +
          `"${wanted}".`
      : `${at} is message ${chunk.msgId}, which carries the file name ` +
          `${JSON.stringify(fileName)} rather than "${wanted}".`
  }

  if (size !== chunk.size) {
    return `${at} is ${size} bytes in the chat, the manifest records ${chunk.size}.`
  }

  return null
}

export async function runVerify(backupId, options = {}, deps = {}) {
  const {
    connect = realConnect,
    disconnect = (client) => client.destroy(),
    configDir = defaultConfigDir(),
    searchManifest = findManifestMessage,
    readMessageBytes = realReadMessageBytes,
    getDocuments = realGetDocuments,
    retryOptions = {},
    writeErr = (line) => process.stderr.write(line),
    log: writeLog = (line) => console.log(line),
    silent = false,
  } = deps

  const config = await loadConfig(configDir)
  const { values: settings } = resolveSettings(options, config, { file: configFile(configDir) })
  // Ask about the login before the destination, as list does: telling someone who has never
  // logged in to pick a chat sends them off after the wrong thing.
  assertLoggedIn(config)
  const chat = requireChat(settings)

  const log = silent ? () => {} : writeLog
  const warn = silent ? () => {} : writeErr

  // Upload and restore stay quiet until the third retry so a handful of -503s do not bury
  // the progress bar. There is no bar here to bury — this command sends a handful of small
  // requests and prints one verdict — so a wait long enough to notice is announced at once.
  function onRetry(err, attempt, delayMs) {
    warn(
      `\nTemporary error (${err.message}), retry ${attempt} in ` +
        `${formatDuration(delayMs / 1000)}.\n`,
    )
  }

  const client = await connect(config, { verbose: settings.verbose })

  try {
    const manifestMessage = await searchManifest(client, chat, backupId)

    if (!manifestMessage) {
      throw new Error(
        `No backup ${backupId} found in ${chatName(chat)}. Check the id with ` +
          '"npx telstore list", or use --chat to point at the right chat.',
      )
    }

    // The full layout checks, not the lenient path delete takes. delete reads a manifest to
    // destroy what it names, so a broken one is exactly what somebody is there to remove;
    // verify reads it to answer whether restore would work, and restore would refuse this
    // one. Saying so in parseManifest's own words keeps one description of one fault.
    const manifest = parseManifest(await readMessageBytes(client, manifestMessage))

    // The same refusal delete makes, for the same reason from the other side: the manifest
    // was found by the file name telstore wrote, so a body naming another backup is a file
    // that was renamed or replaced, and its message ids describe somebody else's chunks.
    // Reporting those as this backup's health is the one wrong answer this command can give.
    if (manifest.id !== undefined && manifest.id !== backupId) {
      throw new Error(
        `The manifest named ${manifestFileName(backupId)} describes backup ` +
          `${JSON.stringify(manifest.id)}, not ${backupId}. Its message ids point at another ` +
          `backup's chunks, so telstore cannot say whether ${backupId} is still there.`,
      )
    }

    const total = manifest.chunks.length

    log(`Backup ${backupId}`)
    log(
      `File   ${describeName(manifest.name)} ` +
        `(${formatBytes(manifest.size)}, ${plural(total, 'chunk')})`,
    )
    log(`In     ${describeChat(chat)}`)
    log('')

    // A backup at the 10000-chunk ceiling is a hundred requests, sent one at a time. Silence
    // for that long reads as a hang, which is the one thing no wait in this project may look
    // like — and below a single request there is no progress worth a line.
    const loud = total > MESSAGE_BATCH_SIZE

    const found = await getDocuments(
      client,
      chat,
      manifest.chunks.map((chunk) => chunk.msgId),
      {
        retryOptions: { ...retryOptions, onRetry },
        onBatch: (done, all) => {
          if (loud) warn(`\rChecking chunk messages ${done}/${all}…`)
        },
      },
    )

    if (loud) warn('\n')

    const damaged = []

    for (const chunk of manifest.chunks) {
      const fault = inspect(chunk, found.get(chunk.msgId), { backupId, total, chat })

      if (fault) {
        damaged.push(fault)
        log(fault)
      }
    }

    if (damaged.length > 0) {
      log('')
      log(
        `${plural(total, 'chunk')} checked, ${damaged.length} damaged. ` +
          'This backup cannot be restored.',
      )
    } else {
      log(
        `${plural(total, 'chunk')} present, at the ` +
          `${total === 1 ? 'size' : 'sizes'} the manifest records.`,
      )
      log('This does not download them, so it cannot prove their contents.')
      log('')
      log(`Restore with: npx telstore restore ${backupId}`)
    }

    return { id: backupId, name: manifest.name, chunks: total, damaged }
  } finally {
    await closeQuietly(client, disconnect)
  }
}

// A backup is a failure whether telstore could not look it up or looked and found it broken.
// The command worked either way — but "did the run find everything it was asked to check"
// is the question the exit code answers, and both answers to that are no.
function isFailure(result) {
  return Boolean(result.error) || result.damaged.length > 0
}

// The same shape as runDeletes and runRestores, minus the question: verify removes nothing,
// so there is nothing to authorise. What is knowable before the connection is refused up
// front; what only the chat can answer is per id, named when it happens and again at the end.
export async function runVerifies(backupIds, options = {}, deps = {}) {
  const {
    connect = realConnect,
    disconnect = (client) => client.destroy(),
    configDir = defaultConfigDir(),
    writeErr = (line) => process.stderr.write(line),
    log: writeLog = (line) => console.log(line),
    silent = false,
  } = deps

  // One id keeps its own wording and its own thrown error. A summary about one backup only
  // repeats the lines above it.
  if (backupIds.length === 1) {
    const result = await runVerify(backupIds[0], options, deps)
    return { results: [result], failed: isFailure(result) ? 1 : 0 }
  }

  const duplicate = backupIds.find((id, index) => backupIds.indexOf(id) !== index)

  if (duplicate) {
    throw new Error(
      `${duplicate} is named twice. Checking one backup twice asks the chat the same ` +
        'question again — name it once.',
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
    await perId.connect(config, { verbose: settings.verbose })

    for (const [index, backupId] of backupIds.entries()) {
      if (index > 0) log('')
      log(`[${index + 1}/${backupIds.length}] ${backupId}`)

      try {
        results.push(await runVerify(backupId, options, perId))
      } catch (err) {
        // Unlike delete, an id nothing knows about does not stop the run: nothing here is
        // destroyed, and the other ids are exactly the ones somebody is checking on.
        results.push({ id: backupId, error: err.message, damaged: [] })
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

  const failed = results.filter(isFailure).length

  log('')
  for (const line of summaryLines(results, failed)) log(line)

  return { results, failed }
}

// Every id gets a line whether it checked out or not: one missing from this list would be a
// backup nobody could tell the state of, which is the whole reason this command exists.
function summaryLines(results, failed) {
  const width = Math.max(...results.map((result) => result.id.length))

  return [
    `${results.length} backups: ${results.length - failed} verified, ${failed} failed.`,
    '',
    ...results.map((result) => {
      const id = result.id.padEnd(width)

      if (result.error) return `  ${id}  failed: ${result.error}`

      return result.damaged.length > 0
        ? `  ${id}  ${plural(result.damaged.length, 'chunk')} damaged`
        : `  ${id}  ${plural(result.chunks, 'chunk')} present`
    }),
  ]
}
