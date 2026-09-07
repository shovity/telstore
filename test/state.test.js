import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  stateKey,
  loadState,
  saveState,
  markChunkDone,
  clearState,
  stateDir,
  listStates,
  pruneStates,
  MAX_STATES,
  findStates,
  findRestores,
  canResume,
  restoreKey,
  restoreFile,
  loadRestore,
  saveRestore,
  clearRestore,
  listRestores,
  pruneRestores,
  MAX_RESTORES,
} from '../src/state.js'

import { tempDir } from './helpers.js'

function sampleState(overrides = {}) {
  return {
    id: 'telstore-20260905-7f3a91',
    chat: '@my_backups',
    path: '/home/ai/data.tar',
    size: 100,
    mtimeMs: 1757000000000,
    chunkSize: 40,
    done: {},
    ...overrides,
  }
}

test('stateKey is stable across calls', () => {
  const a = stateKey('/home/ai/data.tar', 100, 1757000000000)
  const b = stateKey('/home/ai/data.tar', 100, 1757000000000)
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{40}$/)
})

test('stateKey changes when the file changes', () => {
  const original = stateKey('/home/ai/data.tar', 100, 1757000000000)
  assert.notEqual(stateKey('/home/ai/data.tar', 101, 1757000000000), original)
  assert.notEqual(stateKey('/home/ai/data.tar', 100, 1757000000001), original)
  assert.notEqual(stateKey('/home/ai/other.tar', 100, 1757000000000), original)
})

test('stateDir lives under the config directory', async () => {
  const dir = await tempDir('state')
  assert.equal(stateDir(dir), path.join(dir, 'state'))
})

test('loadState returns null when nothing is stored', async () => {
  const dir = await tempDir('state')
  assert.equal(await loadState('missing', dir), null)
})

test('saveState then loadState round-trips the data', async () => {
  const dir = await tempDir('state')
  const state = sampleState()

  await saveState('k1', state, dir)

  assert.deepEqual(await loadState('k1', dir), state)
})

test('markChunkDone persists progress immediately', async () => {
  const dir = await tempDir('state')
  const state = sampleState()
  await saveState('k1', state, dir)

  const updated = await markChunkDone('k1', state, 0, { msgId: 1234, size: 40, sha256: 'a3f1' }, dir)

  assert.deepEqual(updated.done['0'], { msgId: 1234, size: 40, sha256: 'a3f1' })
  assert.deepEqual((await loadState('k1', dir)).done['0'], { msgId: 1234, size: 40, sha256: 'a3f1' })
})

test('markChunkDone accumulates instead of overwriting earlier chunks', async () => {
  const dir = await tempDir('state')
  let state = sampleState()
  await saveState('k1', state, dir)

  state = await markChunkDone('k1', state, 0, { msgId: 1, size: 40, sha256: 'aa' }, dir)
  state = await markChunkDone('k1', state, 1, { msgId: 2, size: 40, sha256: 'bb' }, dir)

  const onDisk = await loadState('k1', dir)
  assert.deepEqual(Object.keys(onDisk.done).sort(), ['0', '1'])
})

test('saveState leaves no temporary file behind', async () => {
  const dir = await tempDir('state')

  await saveState('k1', sampleState(), dir)

  assert.deepEqual(await fs.readdir(stateDir(dir)), ['k1.json'])
})

test('clearState removes the state and stays quiet if it is already gone', async () => {
  const dir = await tempDir('state')
  await saveState('k1', sampleState(), dir)

  await clearState('k1', dir)
  await clearState('k1', dir)

  assert.equal(await loadState('k1', dir), null)
})

test('listStates returns every unfinished backup and skips unreadable files', async () => {
  const dir = await tempDir('state')
  await saveState('aaa', sampleState({ id: 'telstore-1' }), dir)
  await saveState('bbb', sampleState({ id: 'telstore-2', path: '/home/ai/vm.qcow2' }), dir)
  await fs.writeFile(path.join(stateDir(dir), 'ccc.json'), '{ not json')

  const states = await listStates(dir)

  assert.deepEqual(
    states.map(({ state }) => state.id).sort(),
    ['telstore-1', 'telstore-2'],
  )
})

// canResume answers by recomputing the key and comparing it with the one the record is
// filed under, so the caller needs that key — and only the file name has it, since the
// record's own numbers are what a rewritten file makes stale.
test('listStates hands back the key each record is filed under', async () => {
  const dir = await tempDir('state')
  await saveState('aaa', sampleState({ id: 'telstore-1' }), dir)

  assert.deepEqual(
    (await listStates(dir)).map(({ key }) => key),
    ['aaa'],
  )
})

test('listStates on a machine that has never run an upload returns nothing', async () => {
  assert.deepEqual(await listStates(await tempDir('state')), [])
})

// Every state file is written the moment a chunk lands, so the file's own mtime is the
// last time this backup made progress. Tests set it explicitly rather than racing the clock.
async function saveStateAged(key, state, dir, ageMinutes) {
  await saveState(key, state, dir)
  const when = new Date(Date.UTC(2026, 8, 5) - ageMinutes * 60_000)
  await fs.utimes(path.join(stateDir(dir), `${key}.json`), when, when)
}

test('pruneStates keeps the newest states and drops the older ones', async () => {
  const dir = await tempDir('state')
  await saveStateAged('old', sampleState({ id: 'telstore-old' }), dir, 300)
  await saveStateAged('mid', sampleState({ id: 'telstore-mid' }), dir, 200)
  await saveStateAged('new', sampleState({ id: 'telstore-new' }), dir, 100)

  await pruneStates(dir, 2)

  const left = await listStates(dir)
  assert.deepEqual(left.map(({ state }) => state.id).sort(), ['telstore-mid', 'telstore-new'])
})

test('pruneStates names the backups it dropped', async () => {
  const dir = await tempDir('state')
  await saveStateAged('old', sampleState({ id: 'telstore-old' }), dir, 300)
  await saveStateAged('new', sampleState({ id: 'telstore-new' }), dir, 100)

  const dropped = await pruneStates(dir, 1)

  assert.deepEqual(dropped.map((s) => s.id), ['telstore-old'])
})

test('pruneStates below the limit changes nothing', async () => {
  const dir = await tempDir('state')
  await saveStateAged('a', sampleState({ id: 'telstore-1' }), dir, 200)
  await saveStateAged('b', sampleState({ id: 'telstore-2' }), dir, 100)

  assert.deepEqual(await pruneStates(dir, 20), [])
  assert.equal((await listStates(dir)).length, 2)
})

test('pruneStates deletes an unreadable state file without naming it', async () => {
  const dir = await tempDir('state')
  await saveStateAged('good', sampleState({ id: 'telstore-good' }), dir, 100)
  await fs.writeFile(path.join(stateDir(dir), 'broken.json'), '{ not json')
  const old = new Date(Date.UTC(2026, 8, 5) - 300 * 60_000)
  await fs.utimes(path.join(stateDir(dir), 'broken.json'), old, old)

  const dropped = await pruneStates(dir, 1)

  assert.deepEqual(dropped, [])
  assert.deepEqual(await fs.readdir(stateDir(dir)), ['good.json'])
})

test('pruneStates on a machine that has never run an upload does nothing', async () => {
  assert.deepEqual(await pruneStates(await tempDir('state')), [])
})

test('the default limit is 20 unfinished backups', () => {
  assert.equal(MAX_STATES, 20)
})

test('findStates returns the record of a backup together with the file it came from', async () => {
  const dir = await tempDir('state')
  await saveState('abc123', sampleState({ id: 'telstore-wanted' }), dir)
  await saveState('def456', sampleState({ id: 'telstore-other' }), dir)

  const found = await findStates('telstore-wanted', dir)

  assert.equal(found.length, 1)
  assert.equal(found[0].key, 'abc123')
  assert.equal(found[0].file, path.join(stateDir(dir), 'abc123.json'))
  assert.equal(found[0].state.id, 'telstore-wanted')
})

// The key is a hash of the path, size and mtime *inside* the record, so recomputing it
// would trust an untrusted file to say where it lives. A hand-edited path yields a key
// naming no file at all, and clearState ignores a file that is not there — telstore would
// report a record dropped that is still sitting on disk.
test('findStates reports the real file name even when the record disagrees with it', async () => {
  const dir = await tempDir('state')
  await saveState('handpicked', sampleState({ id: 'telstore-wanted', path: '/somewhere/else' }), dir)

  const [found] = await findStates('telstore-wanted', dir)

  assert.equal(found.key, 'handpicked')
})

test('findStates returns every record claiming the same backup id', async () => {
  const dir = await tempDir('state')
  await saveState('one', sampleState({ id: 'telstore-twin' }), dir)
  await saveState('two', sampleState({ id: 'telstore-twin', path: '/other.tar' }), dir)

  assert.equal((await findStates('telstore-twin', dir)).length, 2)
})

test('findStates skips a state file that cannot be read instead of failing', async () => {
  const dir = await tempDir('state')
  await saveState('good', sampleState({ id: 'telstore-wanted' }), dir)
  await fs.writeFile(path.join(stateDir(dir), 'broken.json'), '{ not json')

  assert.equal((await findStates('telstore-wanted', dir)).length, 1)
})

test('findStates on a machine that has never run an upload finds nothing', async () => {
  assert.deepEqual(await findStates('telstore-wanted', await tempDir('state')), [])
})

// A record is filed under a key hashed from the file's path, size and mtime, and runUpload
// looks a resume up by hashing the file it finds on disk. canResume answers whether those
// two hashes still agree, so a helper builds a record from a file that really exists.
async function recordFor(dir, name = 'data.tar', body = 'hello') {
  const file = path.join(dir, name)
  await fs.writeFile(file, body)
  const stat = await fs.stat(file)
  const state = sampleState({ path: file, size: stat.size, mtimeMs: stat.mtimeMs })

  return { file, state, key: stateKey(file, stat.size, stat.mtimeMs) }
}

test('canResume accepts a file that still matches the record it is filed under', async () => {
  const dir = await tempDir('state')
  const { state, key } = await recordFor(dir)

  assert.deepEqual(await canResume(key, state), { ok: true })
})

test('canResume refuses a file that has been rewritten since the backup started', async () => {
  const dir = await tempDir('state')
  const { file, state, key } = await recordFor(dir)
  await fs.writeFile(file, 'hello again, longer this time')

  assert.deepEqual(await canResume(key, state), { ok: false, reason: 'changed' })
})

// Same bytes, later mtime: the size alone would call this resumable, but stateKey hashes
// the mtime too, so runUpload would file it under a new key and start a second backup.
test('canResume refuses a file touched since the backup started, size unchanged', async () => {
  const dir = await tempDir('state')
  const { file, state, key } = await recordFor(dir)
  const later = new Date(Date.now() + 60_000)
  await fs.utimes(file, later, later)

  assert.deepEqual(await canResume(key, state), { ok: false, reason: 'changed' })
})

test('canResume refuses a file that is no longer there', async () => {
  const dir = await tempDir('state')
  const { file, state, key } = await recordFor(dir)
  await fs.unlink(file)

  assert.deepEqual(await canResume(key, state), { ok: false, reason: 'missing' })
})

test('canResume refuses a path that is no longer a file', async () => {
  const dir = await tempDir('state')
  const { file, state, key } = await recordFor(dir)
  await fs.unlink(file)
  await fs.mkdir(file)

  assert.deepEqual(await canResume(key, state), { ok: false, reason: 'not-a-file' })
})

// A state file is untrusted input, and a hand-edited path that is not a string makes
// fs.stat throw a type error rather than ENOENT. status calls this for every record it
// prints, so it must come back with an answer instead of taking the report down.
test('canResume refuses a damaged path rather than throwing', async () => {
  const state = sampleState({ path: null })

  assert.deepEqual(await canResume('k1', state), { ok: false, reason: 'unreadable' })
})

function sampleRestore(overrides = {}) {
  return {
    v: 1,
    id: 'telstore-20260901-7c1b40',
    target: '/home/ai/out.tar',
    chat: '@my_backups',
    size: 1000,
    chunks: 3,
    done: 1,
    ...overrides,
  }
}

test('restoreKey is stable and does not collide with an upload key', async () => {
  const a = restoreKey('telstore-20260901-7c1b40', '/home/ai/out.tar')
  const b = restoreKey('telstore-20260901-7c1b40', '/home/ai/out.tar')

  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{40}$/)
  assert.notEqual(a, restoreKey('telstore-20260901-7c1b40', '/home/ai/other.tar'))
})

test('a restore record round-trips, and a missing one reads as null', async () => {
  const configDir = await tempDir('state')
  const key = restoreKey('telstore-20260901-7c1b40', '/home/ai/out.tar')

  assert.equal(await loadRestore(key, configDir), null)

  await saveRestore(key, sampleRestore(), configDir)

  assert.deepEqual(await loadRestore(key, configDir), sampleRestore())
})

test('clearRestore removes the record and ignores one that is not there', async () => {
  const configDir = await tempDir('state')
  const key = restoreKey('telstore-20260901-7c1b40', '/home/ai/out.tar')

  await saveRestore(key, sampleRestore(), configDir)
  await clearRestore(key, configDir)
  await clearRestore(key, configDir)

  assert.equal(await loadRestore(key, configDir), null)
})

test('the two record kinds are invisible to each other', async () => {
  const configDir = await tempDir('state')

  await saveState(stateKey('/home/ai/data.tar', 100, 1757000000000), sampleState(), configDir)
  await saveRestore(restoreKey('telstore-20260901-7c1b40', '/home/ai/out.tar'), sampleRestore(), configDir)

  const uploads = await listStates(configDir)
  const restores = await listRestores(configDir)

  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].state.path, '/home/ai/data.tar')
  assert.equal(restores.length, 1)
  assert.equal(restores[0].record.target, '/home/ai/out.tar')
})

test('a restore record is skipped when it cannot say what it is about', async () => {
  const configDir = await tempDir('state')
  const key = restoreKey('telstore-20260901-7c1b40', '/home/ai/out.tar')

  await saveRestore(key, { v: 1, done: 2 }, configDir)

  assert.deepEqual(await listRestores(configDir), [])
})

test('pruning uploads never evicts a restore, and the reverse', async () => {
  const configDir = await tempDir('state')

  for (let i = 0; i < MAX_STATES + 3; i += 1) {
    await saveState(stateKey(`/home/ai/f${i}.tar`, i, i), sampleState({ id: `up-${i}` }), configDir)
  }

  for (let i = 0; i < 4; i += 1) {
    await saveRestore(restoreKey(`telstore-r${i}`, `/home/ai/o${i}.tar`), sampleRestore({ id: `re-${i}` }), configDir)
  }

  await pruneStates(configDir)

  assert.equal((await listStates(configDir)).length, MAX_STATES)
  assert.equal((await listRestores(configDir)).length, 4)

  for (let i = 0; i < MAX_RESTORES + 2; i += 1) {
    await saveRestore(restoreKey(`telstore-x${i}`, `/home/ai/x${i}.tar`), sampleRestore({ id: `x-${i}` }), configDir)
  }

  await pruneRestores(configDir)

  assert.equal((await listRestores(configDir)).length, MAX_RESTORES)
  assert.equal((await listStates(configDir)).length, MAX_STATES)
})

test('listStates reports when each record last made progress', async () => {
  const configDir = await tempDir('state')
  const key = stateKey('/home/ai/data.tar', 100, 1757000000000)

  await saveState(key, sampleState(), configDir)

  const [entry] = await listStates(configDir)

  assert.equal(typeof entry.mtimeMs, 'number')
  assert.ok(entry.mtimeMs > 0)
})

test('findRestores returns every record claiming an id, and none claiming another', async () => {
  const configDir = await tempDir('state')

  // The same backup restored to two places is two records, and delete has to drop both:
  // leaving one behind is a signpost to a backup that is no longer there.
  await saveRestore(
    restoreKey('telstore-a', '/home/ai/one.tar'),
    sampleRestore({ id: 'telstore-a', target: '/home/ai/one.tar' }),
    configDir,
  )
  await saveRestore(
    restoreKey('telstore-a', '/home/ai/two.tar'),
    sampleRestore({ id: 'telstore-a', target: '/home/ai/two.tar' }),
    configDir,
  )
  await saveRestore(
    restoreKey('telstore-b', '/home/ai/three.tar'),
    sampleRestore({ id: 'telstore-b', target: '/home/ai/three.tar' }),
    configDir,
  )

  const found = await findRestores('telstore-a', configDir)

  assert.deepEqual(
    found.map((entry) => entry.record.target).sort(),
    ['/home/ai/one.tar', '/home/ai/two.tar'],
  )
  assert.ok(found.every((entry) => entry.file.endsWith('.json')))
  assert.deepEqual(await findRestores('telstore-none', configDir), [])
})

test('findRestores ignores upload records with the same id', async () => {
  const configDir = await tempDir('state')

  await saveState(stateKey('/home/ai/data.tar', 1, 1), sampleState({ id: 'telstore-a' }), configDir)

  assert.deepEqual(await findRestores('telstore-a', configDir), [])
})
