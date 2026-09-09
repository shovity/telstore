import { promises as fs } from 'node:fs'

import { countChunks } from '../chunking.js'
import { describeChat } from '../chat.js'
import { closeQuietly, connect as realConnect } from '../client.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import { formatBytes, plural } from '../progress.js'
import { assertLoggedIn } from '../session.js'
import { resolveSettings } from '../settings.js'
import { deleteCommand, shellArg } from '../shell.js'
import { canResume, listRestores, listStates, listTempChunks, tempDirFor } from '../state.js'

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

// runUpload refuses to send the rest of a backup to a different chat, so the command has to
// name the one the chunks are already in — unless the destination in force is that chat
// anyway, where --chat would just be noise. Not knowing the destination counts as not matching:
// leaving --chat out would be a guess about where a backup already in progress went.
//
// The delete command this file also prints does the opposite and always names the chat, and
// the two are not the same risk: a resume is the same upload again, and runUpload refuses
// outright to send the rest of a backup somewhere else, while a delete pasted a week later
// would destroy whatever happens to carry those ids in the chat it resolves. That rule lives
// in `deleteCommand` in shell.js, for all four places that print the line; `recordChat` below
// is what keeps this caller away from its chatless branch.
function resumeCommand(state, destination) {
  const matches = destination !== null && state.chat === String(destination)

  return `npx telstore ${shellArg(state.path)}${matches ? '' : ` --chat ${shellArg(state.chat)}`}`
}

// status is the command someone runs *because* something is wrong, so a record a truncated
// write or a hand edit mangled is nearer its normal case than its edge case. These two read
// what a stream record claims and say when it claims nothing, because the alternative is the
// report this block was written to end: `From undefined`, `--chat undefined`.
//
// Named for the record it reads, not for the job: `down` describes both kinds of record and
// answers differently on purpose, and one name over two answers is how the two drifted apart
// far enough that a whitespace-only name printed as blank in one of them.
function describeStreamSource(state) {
  return typeof state.name === 'string' && state.name.trim() !== ''
    ? `${state.name} (a command's output)`
    : "a command's output this record does not name"
}

// Null is what stops a delete command being built at all. A record that cannot say where its
// chunks went would produce `--chat undefined`, and a command carrying that is worse than no
// command: runDelete would take it as no destination at all, resolve one from config, and
// fire these message ids at whatever peer that turns out to be. Written as String(chat), so
// anything else here is damage; a number is still taken, because a channel id is one.
function recordChat(state) {
  const { chat } = state

  if (typeof chat === 'number' && Number.isFinite(chat)) return String(chat)
  if (typeof chat === 'string' && chat.trim() !== '') return chat

  return null
}

// Why a resume is off the table, in the words of the thing the user would have to fix. The
// record is keyed on the file's path, size and mtime, so any of these means runUpload would
// hash the file to a different key, find nothing, and start a second backup instead.
//
// 'stream' is deliberately absent: a stream record never reaches here, because it is not an
// unfinished transfer at all and gets its own block below. The fallback beside the lookup is
// for the reason canResume grows next — an unnamed reason is a report that reads "not
// possible: undefined", which is the one thing this file must never print.
const NO_RESUME = {
  missing: 'the file is no longer there',
  changed: 'the file has changed since the backup started',
  'not-a-file': 'that path is no longer a file',
  unreadable: 'the record does not name a file that can be read',
}

// Why the .partial cannot be resumed from, in the same spirit as NO_RESUME above: an
// EACCES or an ELOOP is not the same fact as the file being gone, and telling the user
// their multi-gigabyte download vanished when it is sitting there, unreadable, sends them
// looking for the wrong problem.
const NO_PARTIAL_RESUME = {
  missing: 'the partial download is no longer there',
  unreadable: 'the partial download cannot be read',
}

// A command is printed only when it will really resume. Printing one regardless would be
// telling the user to run something that quietly starts a second backup and abandons every
// chunk this one already sent — and those chunks are then findable only by this id, which
// is worth saying while there are any.
//
// The check is passed in rather than made here: the caller has to know a stream record before
// it prints a File row, and asking canResume twice is how the two answers start to drift.
function resumeLines(check, state, destination, done) {
  if (check.ok) return [field('Resume', resumeCommand(state, destination))]

  const reason = NO_RESUME[check.reason] ?? `the record cannot be resumed (${check.reason})`
  const lines = [field('Resume', `not possible: ${reason}.`)]

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
  } catch (err) {
    const reason = err.code === 'ENOENT' ? 'missing' : 'unreadable'

    return field('Resume', `not possible: ${NO_PARTIAL_RESUME[reason]}.`)
  }

  return field('Resume', restoreCommand(record, destination))
}

// The one thing under ~/.telstore that is not a record. A stream upload buffers a chunk into
// ~/.telstore/tmp while it sends it and removes it as it goes, so a file there is either a run
// happening at this moment or a run that was stopped where it stood — a SIGKILL, a crash, a
// machine losing power, and until this branch a second Ctrl-C. What it costs is a whole chunk
// of disk, 1800MB by default, that nothing on this machine mentions: the backup's record can be
// cleared by a `delete` the run itself printed, after which `status` says "Unfinished none"
// over 37MB of leftovers — measured in the e2e channel, three runs, 2026-09-09. `down` removes
// them, and `down` is the command that removes everything, so somebody who only wants their
// disk back has to be told here instead.
//
// Named, never removed — not by status and not by any other run. From outside the run that owns
// one, a file being filled right now and a file left by a run that died are the same file, and
// removing the first is the confident wrong answer this project refuses everywhere else. So the
// listing says what is there and what the two possibilities are, and the person decides. That is
// the same choice `down` makes about entries it did not put in the directory.
function tempChunkLines(temp, configDir, error) {
  // Not silence, because "nothing is there" is exactly what this cannot know: a directory
  // that will not open may be holding a whole chunk. Said as the one line it is, with the
  // rest of the report still around it, the same way a settings row that will not parse is.
  if (error !== null) {
    return [
      '',
      `${tempDirFor(configDir)} could not be read: ${error}. A backup made from a command`,
      'buffers a chunk there, so there may be one holding up to a whole chunk of disk.',
    ]
  }

  if (temp.length === 0) return []

  const known = temp.filter((entry) => entry.size !== null)
  const total = known.reduce((sum, entry) => sum + entry.size, 0)
  // "at least" rather than a number that quietly leaves one out: a file whose size could not
  // be read is still holding whatever it is holding.
  const size = known.length === temp.length ? formatBytes(total) : `at least ${formatBytes(total)}`
  const width = Math.max(...temp.map((entry) => entry.name.length))

  const lines = [
    '',
    `${plural(temp.length, 'chunk file')}, ${size} in all, in ${tempDirFor(configDir)}:`,
    '',
  ]

  for (const entry of temp) {
    const held = entry.size === null ? 'size unknown' : formatBytes(entry.size)

    lines.push(`  ${entry.name.padEnd(width)}  ${held}`)
  }

  lines.push('')
  lines.push('A backup made from a command buffers one chunk here while it sends it and removes')
  lines.push('it afterwards, so these are either runs happening right now or runs that were')
  lines.push('killed before they could clean up. telstore does not remove them on its own — from')
  lines.push('outside the run that owns one it cannot tell those two apart. Remove one with:')
  lines.push(`  rm ${shellArg(temp[0].file)}`)

  return lines
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

  // Read before the records are printed and reported after them, and it has to be both: a
  // machine with nothing unfinished on it is exactly where a stranded chunk hides, because
  // that used to be where this report ended.
  //
  // Caught here for the reason every other failure in this command is: status is what someone
  // runs *because* something is wrong, and an unreadable tmp directory must not take the
  // account, the destination and the unfinished backups down with it.
  let temp = []
  let tempError = null

  try {
    temp = await listTempChunks(configDir)
  } catch (err) {
    tempError = err.message
  }

  // In a `finally`, so one damaged record — or a `telstore status | head` that closes the pipe
  // under the write — cannot hide up to 1.8GB of borrowed disk. That is the early `return` this
  // task removed, one layer up: the listing came last, so anything that stopped short of it took
  // it with it, and status is the command someone runs *because* something is already wrong. The
  // error still leaves by its own route; it just does not leave alone.
  try {
    if (uploads.length > 0 || restores.length > 0) {
      for (const line of await unfinishedLines(uploads, restores, settings)) log(line)
    }
  } finally {
    for (const line of tempChunkLines(temp, configDir, tempError)) log(line)
  }
}

// Everything below the rows: one indented block per unfinished transfer, newest first.
// Split out of runStatus only so the temp-chunk listing after it cannot be skipped by an
// early return — which is how it came to be missing in the first place.
async function unfinishedLines(uploads, restores, settings) {
  const lines = []
  const log = (line) => lines.push(line)

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
      log(field('File', `${record.target}  (${formatBytes(record.size)})`))
      log(field('Chunks', `${record.done ?? 0} of ${record.chunks ?? '?'} restored`))
      log(field('Chat', describeChat(record.chat)))
      log(await restoreResumeLine(record, destination))
      continue
    }

    const { key, state } = entry
    const resume = await canResume(key, state)
    const done = Object.keys(state.done ?? {}).length

    log(`  ${state.id}`)

    // A stream record is not an unfinished transfer waiting to be picked up. It has no path,
    // no length and no chunk count to be so far through — the bytes came from a command's
    // stdout, they have gone past, and the next run cuts them differently. What it names is
    // chunks sitting in a chat with nothing pointing at them, which is a different sentence
    // and a different command: the only thing anyone can do with them is remove them.
    if (resume.reason === 'stream') {
      const chat = recordChat(state)

      // Whether a manifest went out is the difference between chunks nothing can name and a
      // backup that is whole but unrecorded, and the record is what says which — a rollback
      // that could not finish writes the card's id here. status asks Telegram nothing in this
      // block, so it reports the record's claim as the record's claim rather than as a fact
      // about the chat, which is the same care delete takes when its search comes up empty.
      //
      // `== null` rather than `=== undefined`, because delete's stateManifestId reads this
      // same field and treats null and absent alike. A record carrying an explicit null — a
      // hand edit, or a writer that spelled "nothing here" out — would otherwise have status
      // promise a manifest while delete reports none: two commands contradicting each other
      // about one record, which is the failure this whole block exists to end.
      const manifest =
        state.manifestMsgId == null
          ? 'with no manifest naming them'
          : 'and the manifest its record names'

      log(field('From', describeStreamSource(state)))
      log(field('Chunks', `${plural(done, 'chunk')} in the chat, ${manifest}`))
      log(field('Chat', chat === null ? 'the record does not say' : describeChat(chat)))
      log(
        field(
          'Remove',
          chat === null
            ? 'not possible: the record does not say which chat the chunks are in.'
            : deleteCommand(state.id, chat),
        ),
      )
      continue
    }

    const total = countChunks(state.size, state.chunkSize)

    log(field('File', `${state.path}  (${formatBytes(state.size)})`))
    log(field('Chunks', `${done} of ${total} uploaded`))
    log(field('Chat', describeChat(state.chat)))

    for (const line of resumeLines(resume, state, destination, done)) log(line)
  }

  return lines
}
