import { promises as fs } from 'node:fs'

import { countChunks } from '../chunking.js'
import { describeChat } from '../chat.js'
import { closeQuietly, connect as realConnect } from '../client.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import { formatBytes } from '../progress.js'
import { assertLoggedIn } from '../session.js'
import { resolveSettings } from '../settings.js'
import { canResume, listRestores, listStates } from '../state.js'

const LABEL_WIDTH = 'Destination'.length + 2

function row(label, value) {
  return `${label.padEnd(LABEL_WIDTH)}${value}`
}

// Each unfinished backup gets its own indented block, so the fields line up under a heading
// that is the id — the one string `restore` and `delete` both take.
const FIELD_WIDTH = 'Resume'.length + 3
const CONTINUATION = ' '.repeat(FIELD_WIDTH + 2)

function field(label, value) {
  return `  ${label.padEnd(FIELD_WIDTH)}${value}`
}

// The Resume line is a command meant to be pasted, so anything a shell would take apart has
// to come back quoted — a path with a space in it is the ordinary case, not an exotic one.
const BARE_ARG = /^[A-Za-z0-9_@%+:,./-]+$/

function shellArg(text) {
  const value = String(text)

  return BARE_ARG.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

// runUpload refuses to send the rest of a backup to a different chat, so the command has to
// name the one the chunks are already in — unless the destination in force is that chat
// anyway, where --chat would just be noise. Not knowing the destination counts as not matching:
// leaving --chat out would be a guess about where a backup already in progress went.
function resumeCommand(state, destination) {
  const matches = destination !== null && state.chat === String(destination)

  return `npx telstore ${shellArg(state.path)}${matches ? '' : ` --chat ${shellArg(state.chat)}`}`
}

// Why a resume is off the table, in the words of the thing the user would have to fix. The
// record is keyed on the file's path, size and mtime, so any of these means runUpload would
// hash the file to a different key, find nothing, and start a second backup instead.
const NO_RESUME = {
  missing: 'the file is no longer there',
  changed: 'the file has changed since the backup started',
  'not-a-file': 'that path is no longer a file',
  unreadable: 'the record does not name a file that can be read',
}

// A command is printed only when it will really resume. Printing one regardless would be
// telling the user to run something that quietly starts a second backup and abandons every
// chunk this one already sent — and those chunks are then findable only by this id, which
// is worth saying while there are any.
async function resumeLines(key, state, destination, done) {
  const check = await canResume(key, state)

  if (check.ok) return [field('Resume', resumeCommand(state, destination))]

  const lines = [field('Resume', `not possible: ${NO_RESUME[check.reason]}.`)]

  if (done > 0) {
    lines.push(
      `${CONTINUATION}${done} chunk${done === 1 ? ' is' : 's are'} already in the chat, ` +
        'searchable by this id.',
    )
  }

  return lines
}

// The record holds an absolute target, and printing it is what makes the pasted line
// correct. Without --out, runRestore resolves the manifest's own name against the current
// directory — a name status does not have (it is in a manifest on Telegram, and status
// reaches Telegram only for the account line, where it deliberately tolerates failure) and
// a directory status cannot assume. A command pasted from elsewhere would resolve to
// another path, miss the .partial and start over, which is the failure resume exists to end.
function restoreCommand(record, destination) {
  const matches = destination !== null && record.chat === String(destination)
  const chat = matches ? '' : ` --chat ${shellArg(record.chat)}`

  return `npx telstore restore ${shellArg(record.id)} --out ${shellArg(record.target)}${chat}`
}

// The .partial is the whole reason a resume is possible, so its absence is the one thing
// worth checking before offering a command that would silently start over.
async function restoreResumeLine(record, destination) {
  try {
    await fs.stat(`${record.target}.partial`)
  } catch {
    return field('Resume', 'not possible: the partial download is no longer there.')
  }

  return field('Resume', restoreCommand(record, destination))
}

// Only the kinds actually present are named. "N backups" fits an upload and not a restore:
// there the backup is finished and sitting in the chat, and it is the restore that stopped.
function unfinishedCount(uploads, restores) {
  const parts = []

  if (uploads > 0) parts.push(`${uploads} upload${uploads === 1 ? '' : 's'}`)
  if (restores > 0) parts.push(`${restores} restore${restores === 1 ? '' : 's'}`)

  return parts.length === 0 ? 'none' : parts.join(', ')
}

function describeAccount(me) {
  const name = [me.firstName, me.lastName].filter(Boolean).join(' ')
  const handle = me.username ? ` (@${me.username})` : ''

  return `${name || me.username || me.phone || 'unknown'}${handle}`
}

// The account line is the only part that needs Telegram, and it is also the only part that
// can fail. Whatever it costs, it must not take the rest of the report down with it: the
// unfinished backups are exactly what someone runs status to see after a session expires.
async function accountLine(config, verbose, deps) {
  const { connect, disconnect } = deps

  try {
    assertLoggedIn(config)
  } catch (err) {
    return err.message
  }

  let client
  try {
    client = await connect(config, { verbose })
  } catch (err) {
    return err.message
  }

  try {
    return describeAccount(await client.getMe())
  } catch (err) {
    return `could not be read: ${err.message}`
  } finally {
    await closeQuietly(client, disconnect)
  }
}

export async function runStatus(options = {}, deps = {}) {
  const {
    configDir = defaultConfigDir(),
    connect = realConnect,
    disconnect = (client) => client.destroy(),
    log = (line) => console.log(line),
  } = deps

  const config = await loadConfig(configDir)

  // status is what someone runs *because* something is wrong, so nothing here may take the
  // whole report down — the same reason accountLine catches its own failures. A stored
  // setting that will not parse is loud everywhere else; here it is loud in the row it
  // belongs to, with the account and the unfinished backups still printed around it.
  let settings = null
  let settingsError = null

  try {
    settings = resolveSettings(options, config, { file: configFile(configDir) }).values
  } catch (err) {
    settingsError = err.message
  }

  // Which config this report is about, and whether the session in it can be read. Printed
  // unconditionally: status never said where it looked before, and a row that shows up only
  // when something is unusual reads as a warning rather than as a fact.
  log(
    row(
      'Session',
      config.sealed
        ? `${configFile(configDir)} (sealed — opened with a passphrase)`
        : configFile(configDir),
    ),
  )
  log(row('Account', await accountLine(config, settings?.verbose ?? false, { connect, disconnect })))
  log(
    row(
      'Destination',
      settingsError ??
        (settings.chat === null
          ? 'none set — run "npx telstore config chat @my_backups" to set one'
          : describeChat(settings.chat)),
    ),
  )

  const uploads = await listStates(configDir)
  const restores = await listRestores(configDir)

  log(row('Unfinished', unfinishedCount(uploads.length, restores.length)))

  if (uploads.length === 0 && restores.length === 0) return

  // The destination is what decides whether a resume command needs a --chat. A row that
  // failed to parse leaves nothing to compare against, which is not the same as a match.
  const destination = settings?.chat ?? null

  // Newest first, by when the record last changed — which is when that transfer last made
  // progress, and the same ordering pruneStates already means by "recent".
  const entries = [
    ...uploads.map((entry) => ({ ...entry, kind: 'upload' })),
    ...restores.map((entry) => ({ ...entry, kind: 'restore' })),
  ].sort((a, b) => b.mtimeMs - a.mtimeMs)

  for (const entry of entries) {
    log('')

    if (entry.kind === 'restore') {
      const { record } = entry

      log(`  ${record.id}`)
      log(field('File', `${record.target}  (${formatBytes(Number.isFinite(record.size) ? record.size : 0)})`))
      log(field('Chunks', `${record.done ?? 0} of ${record.chunks ?? '?'} restored`))
      log(field('Chat', describeChat(record.chat)))
      log(await restoreResumeLine(record, destination))
      continue
    }

    const { key, state } = entry
    const total = countChunks(state.size, state.chunkSize)
    const done = Object.keys(state.done ?? {}).length

    log(`  ${state.id}`)
    log(field('File', `${state.path}  (${formatBytes(state.size)})`))
    log(field('Chunks', `${done} of ${total} uploaded`))
    log(field('Chat', describeChat(state.chat)))

    for (const line of await resumeLines(key, state, destination, done)) log(line)
  }
}
