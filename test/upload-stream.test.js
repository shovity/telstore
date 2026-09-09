import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { runStreamUpload, tempDirFor } from '../src/commands/upload-stream.js'
import { parseManifestCaption } from '../src/caption.js'
import { saveConfig } from '../src/config.js'
import { parseManifest } from '../src/manifest.js'
import { MAX_STATES, findStates } from '../src/state.js'

import { LOGGED_IN, collect, fakeClient, tempDir, uploadDeps } from './helpers.js'

// A producer under test is an async iterable of buffers and a promise: the fake stands in for
// spawnProducer, not for a shell, so nothing here depends on tar or /bin/sh being anywhere.
//
// A hand-rolled generator rather than Readable.from, because Readable.from reads ahead of what
// it is asked for: `between` has to run after the chunk before it was sent, not whenever the
// stream machinery felt like buffering.
async function* source(buffers, between) {
  for (const [index, buffer] of buffers.entries()) {
    if (index > 0 && between) await between(index)
    yield buffer
  }
}

function fakeSpawn(buffers, { code = 0, signal = null, between = null } = {}) {
  const spawn = (childArgv) => {
    spawn.calls.push(childArgv)

    return {
      stdout: source(buffers, between),
      exited: Promise.resolve({ code, signal }),
      kill: (sig = 'SIGTERM') => spawn.killed.push(sig),
    }
  }

  spawn.calls = []
  spawn.killed = []

  return spawn
}

async function workspace(settings = { chat: '@store' }) {
  const dir = await tempDir('upload-stream')
  const configDir = path.join(dir, 'config')
  await saveConfig({ ...LOGGED_IN, settings }, configDir)
  return { dir, configDir, tmp: tempDirFor(configDir) }
}

// partSize 4 against a 10-byte chunk means uploadRange really splits and reassembles, which
// is what makes "the bytes in the chat are the bytes the command wrote" worth asserting.
function streamDeps(client, ws, extra = {}) {
  return {
    ...uploadDeps(client),
    configDir: ws.configDir,
    partSize: 4,
    silent: true,
    ...extra,
  }
}

const TEN = Buffer.alloc(10, 1)
const FIVE = Buffer.alloc(5, 2)

function chunkMessages(client) {
  return client.messages.filter((m) => !m.fileName.endsWith('.manifest.json'))
}

function manifestMessages(client) {
  return client.messages.filter((m) => m.fileName.endsWith('.manifest.json'))
}

test('a command that exits 0 becomes a backup of exactly what it wrote', async () => {
  const ws = await workspace()
  const client = fakeClient()

  const result = await runStreamUpload(
    'a.tar',
    ['tar', 'cf', './a'],
    { 'chunk-size': '10' },
    streamDeps(client, ws, { spawn: fakeSpawn([TEN, FIVE]) }),
  )

  assert.equal(result.chunks, 2)
  assert.equal(result.size, 15)
  assert.match(result.id, /^telstore-\d{8}-[0-9a-f]{6}$/)

  const manifest = JSON.parse(manifestMessages(client).at(-1).bytes.toString())

  assert.equal(manifest.id, result.id)
  assert.equal(manifest.name, 'a.tar')
  assert.equal(manifest.size, 15)
  assert.equal(manifest.chunkSize, 10)
  assert.deepEqual(
    manifest.chunks.map((chunk) => chunk.size),
    [10, 5],
  )
})

// The manifest is the only thing that can bring these bytes back, so it has to survive the
// gate restore puts it through — not merely look right to a test that wrote it.
test('the manifest a stream sends is one restore would accept', async () => {
  const ws = await workspace()
  const client = fakeClient()

  await runStreamUpload(
    'a.tar',
    ['tar', 'cf', './a'],
    { 'chunk-size': '10' },
    streamDeps(client, ws, { spawn: fakeSpawn([TEN, TEN, FIVE]) }),
  )

  const manifest = parseManifest(manifestMessages(client).at(-1).bytes)

  assert.equal(manifest.size, 25)
  assert.equal(manifest.chunks.length, 3)
  assert.deepEqual(
    manifest.chunks.map((chunk) => chunk.msgId),
    chunkMessages(client).map((message) => message.id),
  )
})

test('the bytes in the chat are the bytes the command wrote', async () => {
  const ws = await workspace()
  const client = fakeClient()

  await runStreamUpload(
    'a.tar',
    ['tar', 'cf', './a'],
    { 'chunk-size': '10' },
    streamDeps(client, ws, { spawn: fakeSpawn([TEN, FIVE]) }),
  )

  assert.deepEqual(
    Buffer.concat(chunkMessages(client).map((message) => message.bytes)),
    Buffer.concat([TEN, FIVE]),
  )
})

// Nothing above depends on node's stream machinery, and a real child's stdout is a socket.
test('a real Readable of the child stdout kind is read the same way', async () => {
  const ws = await workspace()
  const client = fakeClient()

  const spawn = () => ({
    stdout: Readable.from([Buffer.alloc(7, 3), Buffer.alloc(9, 4)]),
    exited: Promise.resolve({ code: 0, signal: null }),
    kill: () => {},
  })

  const result = await runStreamUpload(
    'a.tar',
    ['tar', 'cf', './a'],
    { 'chunk-size': '10' },
    streamDeps(client, ws, { spawn }),
  )

  assert.equal(result.size, 16)
  assert.deepEqual(
    Buffer.concat(chunkMessages(client).map((message) => message.bytes)),
    Buffer.concat([Buffer.alloc(7, 3), Buffer.alloc(9, 4)]),
  )
})

test('a chunk from a stream is named after the backup and captioned without a total', async () => {
  const ws = await workspace()
  const client = fakeClient()

  const result = await runStreamUpload(
    'a.tar',
    ['tar', 'cf', './a'],
    { 'chunk-size': '10' },
    streamDeps(client, ws, { spawn: fakeSpawn([TEN, FIVE]) }),
  )

  const [first, second] = chunkMessages(client)

  assert.equal(first.fileName, `${result.id}.part0001`)
  assert.equal(first.caption, `\u{1F4E6} ${result.id} · 1`)
  assert.equal(second.caption, `\u{1F4E6} ${result.id} · 2`)
})

// The chunk captions cannot say how many there are; the card is where the count finally lands.
test('the manifest card carries the count the chunks could not', async () => {
  const ws = await workspace()
  const client = fakeClient()

  const result = await runStreamUpload(
    'a.tar',
    ['tar', 'cf', './a'],
    { 'chunk-size': '10' },
    streamDeps(client, ws, { spawn: fakeSpawn([TEN, FIVE]) }),
  )

  const card = parseManifestCaption(manifestMessages(client).at(-1).caption)

  assert.equal(card.id, result.id)
  assert.equal(card.name, 'a.tar')
  assert.equal(card.chunks, 2)
  assert.equal(card.size, '15 B')
})

test('a note reaches the manifest of a stream backup', async () => {
  const ws = await workspace()
  const client = fakeClient()

  await runStreamUpload(
    'a.tar',
    ['tar', 'cf', './a'],
    { 'chunk-size': '10', note: 'nightly' },
    streamDeps(client, ws, { spawn: fakeSpawn([TEN]) }),
  )

  assert.equal(parseManifest(manifestMessages(client).at(-1).bytes).note, 'nightly')
})

// A note Telegram would refuse has to stop the run before the producer is even started:
// caught later it would kill a pg_dump that had already run for an hour.
test('an unusable note stops the run before the command is started', async () => {
  const ws = await workspace()
  const client = fakeClient()
  const spawn = fakeSpawn([TEN])

  await assert.rejects(
    () =>
      runStreamUpload(
        'a.tar',
        ['tar', 'cf', './a'],
        { note: '' },
        streamDeps(client, ws, { spawn }),
      ),
    /--note is empty/,
  )

  assert.deepEqual(spawn.calls, [])
})

test('no destination stops the run before the command is started', async () => {
  const ws = await workspace({})
  const client = fakeClient()
  const spawn = fakeSpawn([TEN])

  await assert.rejects(
    () => runStreamUpload('a.tar', ['tar', 'cf', './a'], {}, streamDeps(client, ws, { spawn })),
    /No destination set/,
  )

  assert.deepEqual(spawn.calls, [])
})

test('the command telstore was given is the argv it spawns', async () => {
  const ws = await workspace()
  const client = fakeClient()
  const spawn = fakeSpawn([TEN])

  await runStreamUpload(
    'a.tar',
    ['sh', '-c', 'tar c ./a | age -r x'],
    { 'chunk-size': '10' },
    streamDeps(client, ws, { spawn }),
  )

  assert.deepEqual(spawn.calls, [['sh', '-c', 'tar c ./a | age -r x']])
})

test('a command that writes nothing is refused, and nothing is sent', async () => {
  const ws = await workspace()
  const client = fakeClient()

  await assert.rejects(
    () =>
      runStreamUpload('a.tar', ['true'], {}, streamDeps(client, ws, { spawn: fakeSpawn([]) })),
    /true wrote nothing, so there is no backup to make/,
  )

  assert.equal(client.messages.length, 0)
})

// The condition the whole feature rests on: an EOF after a crash and an EOF after success are
// the same event on this end of the pipe, and only the exit code tells them apart.
test('the manifest is not sent when the command exits non-zero', async () => {
  const ws = await workspace()
  const client = fakeClient()

  await assert.rejects(
    () =>
      runStreamUpload(
        'a.tar',
        ['tar', 'cf', './a'],
        { 'chunk-size': '10' },
        streamDeps(client, ws, { spawn: fakeSpawn([TEN, FIVE], { code: 2 }) }),
      ),
    /tar exited 2 after writing 15 B.*not sending the manifest/s,
  )

  assert.equal(chunkMessages(client).length, 2)
  assert.deepEqual(manifestMessages(client), [])
})

test('the manifest is not sent when the command is killed by a signal', async () => {
  const ws = await workspace()
  const client = fakeClient()

  await assert.rejects(
    () =>
      runStreamUpload(
        'a.tar',
        ['tar', 'cf', './a'],
        { 'chunk-size': '10' },
        streamDeps(client, ws, { spawn: fakeSpawn([TEN], { code: null, signal: 'SIGKILL' }) }),
      ),
    /tar was killed by SIGKILL after writing 10 B.*not sending the manifest/s,
  )

  assert.deepEqual(manifestMessages(client), [])
})

// A command that could not start rejects `exited` rather than resolving it, and that report
// names the command — telstore must not paper over it with "wrote nothing".
test('a command that could not start is reported in its own words', async () => {
  const ws = await workspace()
  const client = fakeClient()

  // The no-op catch is spawnProducer's own: `exited` is built before anyone awaits it, and a
  // rejected promise with no handler yet attached makes node report an unhandledRejection.
  const exited = Promise.reject(new Error('Cannot run tarr: no such command on this machine.'))
  exited.catch(() => {})

  const spawn = () => ({ stdout: source([], null), exited, kill: () => {} })

  await assert.rejects(
    () => runStreamUpload('a.tar', ['tarr'], {}, streamDeps(client, ws, { spawn })),
    /Cannot run tarr: no such command on this machine\./,
  )

  assert.equal(client.messages.length, 0)
})

test('the record is cleared once the manifest is in the chat', async () => {
  const ws = await workspace()
  const client = fakeClient()

  const result = await runStreamUpload(
    'a.tar',
    ['tar', 'cf', './a'],
    { 'chunk-size': '10' },
    streamDeps(client, ws, { spawn: fakeSpawn([TEN, FIVE]) }),
  )

  assert.deepEqual(await findStates(result.id, ws.configDir), [])
})

// The record is the only list of what is already in the chat, and a failed run's rollback
// reads exactly this. It has to be right *while* the run is going, not afterwards.
test('the record names the chunks already sent while the run is still going', async () => {
  const ws = await workspace()
  const client = fakeClient()
  const seen = []
  let id = null

  const between = async () => {
    const found = await findStates(id, ws.configDir)
    seen.push(found.map(({ state }) => state))
  }

  await runStreamUpload(
    'a.tar',
    ['tar', 'cf', './a'],
    { 'chunk-size': '10' },
    streamDeps(client, ws, {
      spawn: fakeSpawn([TEN, FIVE], { between }),
      onBackupId: (backupId) => {
        id = backupId
      },
    }),
  )

  assert.equal(seen.length, 1)
  assert.equal(seen[0].length, 1)

  const [state] = seen[0]

  assert.equal(state.kind, 'stream')
  assert.equal(state.chat, '@store')
  assert.equal(state.name, 'a.tar')
  assert.equal(state.chunkSize, 10)
  assert.deepEqual(state.done, {
    0: { msgId: chunkMessages(client)[0].id, size: 10, sha256: state.done['0'].sha256 },
  })
  assert.match(state.done['0'].sha256, /^[0-9a-f]{64}$/)
})

// One chunk of borrowed disk at a time, given back as soon as it is sent. `between` runs
// while chunk N is being filled, so what should be on disk then is chunk N's file and
// nothing else — otherwise a 1.8GB file per chunk piles up under ~/.telstore.
test('only the chunk being filled has a temporary file', async () => {
  const ws = await workspace()
  const client = fakeClient()
  const during = []

  const between = async (index) => {
    during.push({ index, files: await fs.readdir(ws.tmp) })
  }

  const result = await runStreamUpload(
    'a.tar',
    ['tar', 'cf', './a'],
    { 'chunk-size': '10' },
    streamDeps(client, ws, { spawn: fakeSpawn([TEN, TEN, FIVE], { between }) }),
  )

  assert.deepEqual(
    during.map(({ index, files }) => ({ index, files })),
    [
      { index: 1, files: [`${result.id}-1.chunk`] },
      { index: 2, files: [`${result.id}-2.chunk`] },
    ],
  )
  assert.deepEqual(await fs.readdir(ws.tmp), [])
})

test('a run that fails leaves no temporary chunk file behind', async () => {
  const ws = await workspace()
  const client = fakeClient({ failOnChunk: 1 })

  await assert.rejects(
    () =>
      runStreamUpload(
        'a.tar',
        ['tar', 'cf', './a'],
        { 'chunk-size': '10' },
        streamDeps(client, ws, { spawn: fakeSpawn([TEN, TEN, FIVE]) }),
      ),
    /connection dropped mid-transfer/,
  )

  assert.deepEqual(await fs.readdir(ws.tmp), [])
})

// A stream cannot be re-cut, so the only way out of an endless producer is a bigger chunk.
test('more chunks than the limit stops the run and names --chunk-size', async () => {
  const ws = await workspace()
  const client = fakeClient()

  await assert.rejects(
    () =>
      runStreamUpload(
        'a.tar',
        ['tar', 'cf', './a'],
        { 'chunk-size': '10' },
        streamDeps(client, ws, { spawn: fakeSpawn([TEN, TEN, TEN, TEN]), maxChunks: 3 }),
      ),
    /already produced 3 chunks of 10 B.*larger --chunk-size/s,
  )

  assert.equal(chunkMessages(client).length, 3)
  assert.deepEqual(manifestMessages(client), [])
})

test('a stream that ends exactly on the limit is not one chunk over it', async () => {
  const ws = await workspace()
  const client = fakeClient()

  const result = await runStreamUpload(
    'a.tar',
    ['tar', 'cf', './a'],
    { 'chunk-size': '10' },
    streamDeps(client, ws, { spawn: fakeSpawn([TEN, TEN, TEN]), maxChunks: 3 }),
  )

  assert.equal(result.chunks, 3)
  assert.equal(result.size, 30)
})

// Same report runUpload makes, and for the same reason: telstore is dropping the only record
// of someone else's chunks, so it says so even when the caller asked for silence.
test('dropping an old record to make room is said out loud', async () => {
  const ws = await workspace()
  const warnings = []
  const stateDirPath = path.join(ws.configDir, 'state')

  await fs.mkdir(stateDirPath, { recursive: true })

  for (let i = 0; i < MAX_STATES; i += 1) {
    const file = path.join(stateDirPath, `stale${i}.json`)
    await fs.writeFile(
      file,
      JSON.stringify({
        id: `telstore-stale-${i}`,
        chat: '@store',
        path: `/home/ai/old-${i}.tar`,
        size: 1000,
        mtimeMs: 1757000000000,
        chunkSize: 400,
        done: {},
      }),
    )
    const when = new Date(Date.UTC(2020, 0, 1) + i * 60_000)
    await fs.utimes(file, when, when)
  }

  await runStreamUpload(
    'a.tar',
    ['tar', 'cf', './a'],
    { 'chunk-size': '10' },
    streamDeps(fakeClient(), ws, {
      spawn: fakeSpawn([TEN]),
      writeErr: (line) => warnings.push(line),
    }),
  )

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /Dropped the record of unfinished backup telstore-stale-0/)
})

// A stream waits on the same Telegram as a file does, and a silent FLOOD_WAIT_3600 leaves
// someone staring at a frozen bar for an hour assuming the process has hung.
test('a long wait is announced in the same words the file path uses', async () => {
  const ws = await workspace()
  const client = fakeClient()
  const lines = []

  let flooded = false
  const originalInvoke = client.invoke.bind(client)

  client.invoke = async (request) => {
    if (!flooded && request.filePart === 0) {
      flooded = true
      const err = new Error('FLOOD_WAIT_3600')
      err.code = 420
      err.seconds = 3600
      err.errorMessage = 'FLOOD_WAIT_3600'
      throw err
    }

    return await originalInvoke(request)
  }

  await runStreamUpload(
    'a.tar',
    ['tar', 'cf', './a'],
    { 'chunk-size': '10' },
    streamDeps(client, ws, {
      spawn: fakeSpawn([TEN]),
      silent: false,
      log: () => {},
      writeErr: (line) => lines.push(line),
      retryOptions: { sleep: async () => {} },
    }),
  )

  const output = lines.join('')

  assert.match(output, /Telegram wants 1h0m/)
  assert.match(output, /FLOOD_WAIT_3600/)
  assert.match(output, /leave it running/)
})

test('the header names the backup, the command and where it is going', async () => {
  const ws = await workspace()
  const out = collect()

  const result = await runStreamUpload(
    'a.tar',
    ['tar', 'cf', './a'],
    { 'chunk-size': '10' },
    streamDeps(fakeClient(), ws, {
      spawn: fakeSpawn([TEN]),
      silent: false,
      log: out.log,
      writeErr: () => {},
    }),
  )

  const text = out.text()

  assert.match(text, new RegExp(`Backup ${result.id}`))
  assert.match(text, /a\.tar/)
  assert.match(text, /tar cf \.\/a/)
  assert.match(text, /@store/)
  assert.match(text, new RegExp(`npx telstore restore ${result.id}`))
})
