import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describeChat } from '../chat.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import { askConfirm } from '../confirm.js'
import { shellArg } from '../shell.js'
import { listRestores, listStates } from '../state.js'

// Nothing here may reach src/client.js, directly or through a command that does: `down` is
// run on a machine somebody is finished with, often one with no network and sometimes one
// they no longer trust. It opens no socket, and test/bin.test.js measures that it stays
// that way — a single import of status.js would put teleproto back in the path.

const LABEL_WIDTH = 'Destination'.length + 2

function row(label, value) {
  return `  ${label.padEnd(LABEL_WIDTH)}${value}`
}

// status prints this same count about this same directory. It cannot be imported from there
// without dragging teleproto in, so it is copied — and copied exactly, because two commands
// disagreeing about what is unfinished on one machine is worse than either wording alone.
function unfinishedCount(uploads, restores) {
  const parts = []

  if (uploads > 0) parts.push(`${uploads} upload${uploads === 1 ? '' : 's'}`)
  if (restores > 0) parts.push(`${restores} restore${restores === 1 ? '' : 's'}`)

  return parts.length === 0 ? 'none' : parts.join(', ')
}

// A recursive remove is the one mistake in this command nobody could apologise for, and the
// path it walks is derived rather than typed — os.homedir() reading an empty HOME is all it
// takes. These two are not reachable by any correct call, which is exactly why they are
// worth refusing by name rather than trusting the caller.
function refuseDangerousTarget(dir) {
  if (dir === os.homedir() || path.dirname(dir) === dir) {
    throw new Error(
      `telstore refuses to remove ${dir}: that is a home directory or a filesystem root, ` +
        'not a telstore config directory. Nothing was removed.',
    )
  }
}

// The config is read to describe it, never to trust it. loadConfig throws on a file that is
// corrupt, that holds a `settings` which is not a group, or that holds both a sealed session
// and a plain one — and its own advice for all three is to delete the file and log in again.
// This is the command that does that, so it is the one command a broken config must not stop.
async function describeConfig(configDir) {
  try {
    return { config: await loadConfig(configDir), error: null }
  } catch (err) {
    return { config: {}, error: err.message }
  }
}

// The error itself is deliberately not quoted here. Every message loadConfig throws names the
// config file, every path to it contains a dot, and a first-sentence split therefore cuts
// "/home/sho/.telstore/config.json is not valid JSON" down to "/home/sho/" — a mangled path
// presented as a diagnosis. The whole message is no better: its advice is "delete the file and
// log in again", which is what this command is in the middle of doing.
function sessionLine(config, error) {
  if (error) return 'cannot be read — whatever is in that file, it goes with the rest'
  if (config.sealed) return 'sealed — the api_id and api_hash are inside it, so they go too'
  if (config.session) return 'stored here in plain text — api_id and api_hash go with it'

  return 'not logged in'
}

// What an unfinished upload was of. A stream record has no path — its bytes came from a
// command's stdout — and carries the name the backup was given instead. This listing exists
// so that nothing goes unnamed before a recursive remove, so a row reading "undefined" is
// the exact failure it is here to prevent.
function describeSource(state) {
  if (typeof state.path === 'string') return state.path
  if (typeof state.name === 'string') return `${state.name} (a command's output)`

  return 'a record that does not say what it was backing up'
}

// The last thing anything anywhere will say about those chunks. down.md prints a resume
// command for a .partial "because this is the last time anything will mention that file", and
// a stream record is the sharper case: it cannot be re-run onto — those bytes have gone past —
// so once this record is gone nothing on this machine lists those message ids and no manifest
// in the chat names them. Printing the command removes nothing and opens no socket; it is the
// naming this whole listing exists for, done for something that lives on Telegram.
//
// The chat is named for the reason status names it: `delete` resolves its own destination from
// config, so a command pasted later without one would fire these ids at whatever chat is
// configured then. A record that cannot say where its chunks went gets no command rather than
// one that would guess: `--chat` missing is not `--chat` empty, and runDelete would take it as
// no destination at all. The id needs no guard here — the listing above measures state.id.length
// for its own column, so a record without one never reaches this line.
function removeCommand(state) {
  const chat = state.chat === null || state.chat === undefined ? '' : String(state.chat).trim()

  if (chat === '') return null

  return `npx telstore delete ${shellArg(state.id)} --chat ${shellArg(chat)}`
}

// Only the ones actually on disk. A restore record survives a .partial that was deleted by
// hand, and pointing at a file that is not there sends somebody looking for nothing.
async function strandedPartials(restores) {
  const found = []

  for (const { record } of restores) {
    const partial = `${record.target}.partial`

    try {
      await fs.stat(partial)
      found.push({ partial, record })
    } catch {
      // Nothing there to tell them about.
    }
  }

  return found
}

// Everything in the directory that telstore did not put there. The whole directory goes
// either way — it is what was asked for — but delete's rule holds here too: nothing is
// removed unnamed.
//
// `tmp` is telstore's too: a stream upload borrows one chunk of disk at a time under
// ~/.telstore rather than /tmp, which is tmpfs on many distributions and would turn a chunk
// size into a memory limit. Naming it here would be down reporting its own working directory
// as a stranger's file — and if a run died mid-chunk it may hold up to one chunk, which the
// recursive remove below takes with everything else.
async function foreignEntries(configDir) {
  const ours = new Set(['config.json', 'config.json.tmp', 'state', 'tmp'])

  try {
    return (await fs.readdir(configDir)).filter((name) => !ours.has(name))
  } catch {
    return []
  }
}

export async function runDown(args = [], options = {}, deps = {}) {
  const {
    configDir = defaultConfigDir(),
    confirm = askConfirm,
    interactive = () => Boolean(process.stdin.isTTY),
    log = (line) => console.log(line),
  } = deps

  // `telstore down telstore-20260905-7f3a91` is the plausible typo — somebody reaching for
  // the command that removes one backup. Obeying it would wipe the machine instead.
  if (args.length > 0) {
    throw new Error(
      `down takes no arguments, but got "${args.join(' ')}". It removes everything on this ` +
        'machine or nothing. To remove one backup from Telegram, use ' +
        '"npx telstore delete <backup-id>".',
    )
  }

  refuseDangerousTarget(configDir)

  try {
    await fs.stat(configDir)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err

    log(`Nothing to remove: ${configDir} is not there.`)
    return { removed: false, dir: configDir }
  }

  const { config, error } = await describeConfig(configDir)
  const uploads = await listStates(configDir)
  const restores = await listRestores(configDir)
  const stranded = await strandedPartials(restores)
  const foreign = await foreignEntries(configDir)
  const chat = config.settings?.chat ?? null

  log('This removes everything telstore keeps on this machine.')
  log('')
  log(row('Directory', configDir))
  log(row('Session', sessionLine(config, error)))
  if (chat !== null) log(row('Destination', describeChat(chat)))
  log(row('Unfinished', unfinishedCount(uploads.length, restores.length)))
  if (foreign.length > 0) log(row('Also there', foreign.join(', ')))

  // The expensive half of what is about to go. An upload record is what lets a second run
  // keep the same backupId and skip the chunks already sent; without it the same file goes
  // up again as a new backup, and the chunks already in the chat stay there under an id
  // nothing on this machine remembers. So the ids are said out loud while someone can read
  // them. A restore record costs nothing to lose — the .partial resumes without it — and is
  // dealt with on the way out instead.
  if (uploads.length > 0) {
    const width = Math.max(...uploads.map(({ state }) => state.id.length))

    log('')
    log('These uploads have not finished. Their records are the only thing that lets a second')
    log('run carry on: without them the same file goes up again as a new backup, and the chunks')
    log('already sent stay in the chat under these ids and nothing else:')
    log('')
    for (const { state } of uploads) log(`  ${state.id.padEnd(width)}  ${describeSource(state)}`)

    const streams = uploads.filter(({ state }) => state.kind === 'stream')

    if (streams.length > 0) {
      log('')
      log('The ones marked as a command\'s output cannot be carried on at all: those bytes have')
      log('gone past, and a second run cuts them differently. Their records are the only list of')
      log('the chunks those runs left in the chat, and nothing replaces them — so this is the')
      log('last chance to copy the commands that remove those chunks:')
      log('')

      for (const { state } of streams) {
        const command = removeCommand(state)

        if (command === null) {
          log(`  ${state.id}`)
          log('    this record does not say which chat its chunks went to, so there is no')
          log('    command that could reach them')
          continue
        }

        log(`  ${command}`)
      }
    }
  }

  log('')
  log('Nothing on Telegram is touched: every backup stays where it is.')

  if (!options.yes) {
    if (!interactive()) {
      throw new Error(
        `Nothing was removed: there is no terminal to confirm in. Run again with --yes to ` +
          `remove ${configDir} without being asked.`,
      )
    }

    log('')

    if (!(await confirm(`This cannot be undone. Remove ${configDir}? [y/N] `))) {
      throw new Error('Cancelled on request.')
    }
  }

  try {
    await fs.rm(configDir, { recursive: true, force: true })
  } catch (err) {
    // fs.rm walks the tree, so a permission error halfway leaves some of it gone. Reporting
    // that as a success is the one thing this project never does.
    throw new Error(
      `Could not remove ${configDir}: ${err.message}. Some of it may already be gone — ` +
        'run "npx telstore down" again once the permissions allow it.',
    )
  }

  log('')
  log(`Done. Removed ${configDir}.`)

  if (config.session || config.sealed || error) {
    log(
      'Note: this only deletes the local copy — the session is still alive on Telegram\'s ' +
        'side. To revoke access for good, open Telegram → Settings → Devices (Active ' +
        'sessions) and terminate that session.',
    )
  }

  if (config.apiId || config.apiHash || config.sealed) {
    log(
      'api_id and api_hash are gone too, which logout would have kept: the next ' +
        '"npx telstore login" asks for them again (my.telegram.org).',
    )
  }

  log(
    chat === null
      ? 'Your backups are still on Telegram. Log in again and "npx telstore list" finds them.'
      : `Your backups are still in ${describeChat(chat)} — log in again and ` +
          '"npx telstore list" finds them.',
  )

  // The .partial is the user's data, and down removes what was asked for and nothing else.
  // Unlike after a delete it can still be finished: the chunks and the manifest a resume
  // checks against were never touched. What is gone is the record that listed it, so this
  // is the last time anything will mention the file at all.
  for (const { partial, record } of stranded) {
    const chatFlag = record.chat ? ` --chat ${shellArg(record.chat)}` : ''

    log('')
    log(`${partial} is a half-finished restore of ${record.id}, and is left where it is.`)
    log('It still resumes — log in again and run it from anywhere:')
    log(
      `  npx telstore restore ${shellArg(record.id)} --out ${shellArg(record.target)}${chatFlag}`,
    )
    log('Nothing else will remind you: the record that listed it went with the rest.')
  }

  return { removed: true, dir: configDir, uploads: uploads.length, restores: restores.length }
}
