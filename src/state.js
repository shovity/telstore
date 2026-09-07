import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { defaultConfigDir, writeJsonAtomic } from './config.js'

export function stateDir(configDir = defaultConfigDir()) {
  return path.join(configDir, 'state')
}

export function stateKey(absPath, size, mtimeMs) {
  return createHash('sha1').update(`${absPath}:${size}:${mtimeMs}`).digest('hex')
}

export function stateFile(key, configDir = defaultConfigDir()) {
  return path.join(stateDir(configDir), `${key}.json`)
}

// A restore's record is filed beside the uploads and must never compete with them for a
// prune slot. Losing an upload record strands chunks in a chat where only the id can still
// find them, which is why pruneStates reads each file back to name what it drops; losing a
// restore record costs one line of `status` for a .partial that still resumes perfectly.
// The name is what keeps them apart — an upload key is 40 hex characters and `r` is not
// hex, so the two namespaces cannot collide.
const RESTORE_PREFIX = 'restore-'

// stateKey's trick does not transfer: a .partial changes size and mtime on every write, so
// there is nothing there to key on. What holds still across runs is the backup being
// restored and the path being written.
export function restoreKey(backupId, absTarget) {
  return createHash('sha1').update(`${backupId}:${absTarget}`).digest('hex')
}

export function restoreFile(key, configDir = defaultConfigDir()) {
  return path.join(stateDir(configDir), `${RESTORE_PREFIX}${key}.json`)
}

// One reader for both kinds. A listing that forgets to filter hands `status` a restore
// record as though it were an upload, canResume stats a path that is not in it, and the
// report comes out wrong without anything failing — so there is one place that filters.
async function recordNames(configDir, restores) {
  let names
  try {
    names = await fs.readdir(stateDir(configDir))
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }

  return names.filter(
    (name) => name.endsWith('.json') && name.startsWith(RESTORE_PREFIX) === restores,
  )
}

function keyOfName(name) {
  const base = name.slice(0, -'.json'.length)

  return base.startsWith(RESTORE_PREFIX) ? base.slice(RESTORE_PREFIX.length) : base
}

// Why loadState returns null rather than throwing, in one place both kinds can use: one
// corrupt file must not hide the other records still waiting to be finished.
async function readRecord(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    if (err instanceof SyntaxError) return null
    throw err
  }
}

async function removeRecord(file) {
  try {
    await fs.unlink(file)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

// The mtime says when a record last made progress, which is the order `status` prints in —
// nothing decides from it whether a record exists. Its content has already been read by the
// time this runs, so a stat that fails must not drop the record or take the listing down:
// an unknown time sorts last and nothing is hidden. The file can genuinely vanish between
// the readdir and here, which is the case this exists for.
async function recordMtime(file) {
  try {
    const { mtimeMs } = await fs.stat(file)
    return mtimeMs
  } catch {
    return 0
  }
}

export async function loadState(key, configDir = defaultConfigDir()) {
  return await readRecord(stateFile(key, configDir))
}

export async function saveState(key, state, configDir = defaultConfigDir()) {
  await writeJsonAtomic(stateFile(key, configDir), state)
}

export async function markChunkDone(key, state, i, entry, configDir = defaultConfigDir()) {
  const updated = { ...state, done: { ...state.done, [String(i)]: entry } }
  await saveState(key, updated, configDir)
  return updated
}

export async function clearState(key, configDir = defaultConfigDir()) {
  await removeRecord(stateFile(key, configDir))
}

export async function loadRestore(key, configDir = defaultConfigDir()) {
  return await readRecord(restoreFile(key, configDir))
}

export async function saveRestore(key, record, configDir = defaultConfigDir()) {
  await writeJsonAtomic(restoreFile(key, configDir), record)
}

export async function clearRestore(key, configDir = defaultConfigDir()) {
  await removeRecord(restoreFile(key, configDir))
}

// A state file is only useful while its backup can still be resumed, and nothing ever
// removes one whose file was edited since: the key includes mtime, so that state can never
// match again. Left alone the directory only grows, and with it the report `status` prints.
export const MAX_STATES = 20

// The newest states are the ones worth keeping, and a state file is rewritten every time a
// chunk lands, so its mtime is when this backup last made progress. Returns the states that
// were dropped: the caller says their ids out loud, because after this the id is the only
// way left to find those chunks in the chat.
export async function pruneStates(configDir = defaultConfigDir(), keep = MAX_STATES) {
  const files = []

  for (const name of await recordNames(configDir, false)) {
    const file = path.join(stateDir(configDir), name)

    try {
      const stat = await fs.stat(file)
      files.push({ key: keyOfName(name), file, mtimeMs: stat.mtimeMs })
    } catch (err) {
      // Gone between readdir and stat: nothing left to prune.
      if (err.code !== 'ENOENT') throw err
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const dropped = []

  for (const { key, file } of files.slice(keep)) {
    // Read before unlink: a file that cannot be read back, or that carries no id, is
    // still pruned — it just cannot be named, and a report naming nothing helps no one.
    const state = await loadState(key, configDir)
    await fs.unlink(file)
    if (state?.id) dropped.push(state)
  }

  return dropped
}

// status needs every unfinished backup at once. A state file that cannot be read is skipped
// rather than fatal, for the same reason loadState returns null: one corrupt file must not
// hide the other backups still waiting to be finished.
//
// The key comes back alongside each record because canResume needs it, and the file name is
// the only place it survives: the record's own path, size and mtime are exactly what a
// rewritten file makes stale, so recomputing the key from them would always say yes. The
// mtime comes back because it is when this backup last made progress, which is the order
// status prints records in.
export async function listStates(configDir = defaultConfigDir()) {
  const states = []

  for (const name of await recordNames(configDir, false)) {
    const key = keyOfName(name)
    const state = await loadState(key, configDir)

    if (!state) continue

    states.push({ key, state, mtimeMs: await recordMtime(path.join(stateDir(configDir), name)) })
  }

  return states
}

// delete needs the file a record came from, not just its contents — and the name of that
// file is a hash of the path, size and mtime *inside* the record, so recomputing it would
// be trusting an untrusted file to say where it lives. A hand-edited path yields a key that
// names no file at all, clearState ignores a file that is not there, and telstore reports a
// record dropped that is still sitting on disk. Matching the id inside each file is the one
// way that cannot point at the wrong one.
//
// Every record claiming the id is returned rather than the first: two of them means telstore
// cannot know which to drop, and that is the caller's decision to refuse, not ours to make
// by picking one.
export async function findStates(backupId, configDir = defaultConfigDir()) {
  const found = []

  for (const name of await recordNames(configDir, false)) {
    const key = keyOfName(name)
    const state = await loadState(key, configDir)

    if (state?.id === backupId) found.push({ key, file: stateFile(key, configDir), state })
  }

  return found
}

// Whether a record can still be resumed, which is not a question about the record alone:
// runUpload hashes the file it finds on disk and looks the result up, so a backup is
// resumable exactly when that hash is still the key this record is filed under. Recomputing
// through stateKey rather than comparing size and mtime by hand is the point — a second way
// of asking is a second way to drift, and status would end up promising a resume that upload
// turns into a brand new backup, stranding every chunk already sent.
//
// Never throws. status calls this for every record it prints, and one damaged path must not
// take the rest of the report down with it.
export async function canResume(key, state) {
  let stat

  try {
    stat = await fs.stat(state.path)
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'missing' }
    return { ok: false, reason: 'unreadable' }
  }

  if (!stat.isFile()) return { ok: false, reason: 'not-a-file' }
  if (stateKey(state.path, stat.size, stat.mtimeMs) !== key) return { ok: false, reason: 'changed' }

  return { ok: true }
}

export const MAX_RESTORES = 20

// A record with no id or no target can neither be printed nor resumed from, so status has
// nothing to do with it. Skipped rather than rendered with blanks: these files are
// hand-editable, and a row that names nothing is worse than no row.
export async function listRestores(configDir = defaultConfigDir()) {
  const restores = []

  for (const name of await recordNames(configDir, true)) {
    const key = keyOfName(name)
    const record = await loadRestore(key, configDir)

    if (typeof record?.id !== 'string' || typeof record?.target !== 'string') continue

    restores.push({ key, record, mtimeMs: await recordMtime(path.join(stateDir(configDir), name)) })
  }

  return restores
}

// Unlike pruneStates this returns nothing and reads nothing back. Dropping a restore record
// strands no data — the .partial it points at still resumes, because the evidence for a
// resume was never in the record — so there is nothing to announce and no reason to open
// each file just to name it. It removes the signpost, never the .partial: a multi-gigabyte
// file must not disappear as a side effect of starting an unrelated restore.
export async function pruneRestores(configDir = defaultConfigDir(), keep = MAX_RESTORES) {
  const files = []

  for (const name of await recordNames(configDir, true)) {
    const file = path.join(stateDir(configDir), name)

    try {
      const stat = await fs.stat(file)
      files.push({ file, mtimeMs: stat.mtimeMs })
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  for (const { file } of files.slice(keep)) await removeRecord(file)
}

// What findStates is for uploads, and for the same reason: the file name hashes the target
// path, which delete does not know — it has an id and nothing else. Matching the id inside
// each file is the only way that cannot point at the wrong one.
//
// Every record claiming the id comes back, not the first. One backup restored to two places
// is two records, and a delete that drops one of them leaves a signpost to chunks that are
// no longer in the chat.
export async function findRestores(backupId, configDir = defaultConfigDir()) {
  const found = []

  for (const name of await recordNames(configDir, true)) {
    const key = keyOfName(name)
    const record = await loadRestore(key, configDir)

    if (record?.id === backupId) found.push({ key, file: restoreFile(key, configDir), record })
  }

  return found
}
