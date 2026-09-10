import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { runRestoreStream } from '../src/commands/restore-stream.js'
import { saveConfig } from '../src/config.js'
import { buildManifest, manifestFileName, serializeManifest } from '../src/manifest.js'
import { tempDirFor } from '../src/state.js'

import { LOGGED_IN, collect, tempDir } from './helpers.js'

const ARGV = ['tar', 'xzf', '-']

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

// Every fake that stands in for a round trip to Telegram yields a turn of the event loop
// before it answers. A fake that resolves in the same tick it was called cannot lose a race it
// would always lose in reality — a child's death reaches this process in microseconds and a
// request to Telegram does not — and the tests below about a command dying mid-run turn on
// exactly which of those two arrives first.
function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

// The chat holding one backup, the shape test/restore.test.js builds. Six bytes in chunks of
// four makes the second chunk shorter than the first — the only layout parseManifest allows —
// so an off-by-one in a length shows up as a missing byte rather than as the same number twice.
function fakeBackup({
  id = 'telstore-20260910-ab12cd',
  name = 'data.tar.gz',
  chunkSize = 4,
  total = 6,
} = {}) {
  const content = Buffer.alloc(total)
  for (let at = 0; at < total; at += 1) content[at] = (at % 251) + 1

  const messages = []
  const chunks = []

  for (let offset = 0, i = 0; offset < total; offset += chunkSize, i += 1) {
    const bytes = content.subarray(offset, Math.min(offset + chunkSize, total))
    const msgId = 1000 + i
    messages.push({ id: msgId, fileName: `${id}.part${String(i + 1).padStart(4, '0')}`, bytes })
    chunks.push({ i, msgId, size: bytes.length, sha256: sha(bytes) })
  }

  const manifest = buildManifest({ id, name, size: total, chunkSize, chunks })
  const manifestBytes = serializeManifest(manifest)
  messages.push({ id: 2000, fileName: manifestFileName(id), bytes: manifestBytes })

  return { id, content, messages, manifest, manifestBytes }
}

// A fake child: a PassThrough for stdin plus a promise for exited, which is every shape
// runRestoreStream asks a command for.
function fakeChild({
  exitCode = 0,
  signal = null,
  failToStart = null,
  stopAfter = null,
  keepRunning = false,
  failOnEof = false,
} = {}) {
  const stdin = new PassThrough()
  const seen = []
  let killed = false

  stdin.on('data', (bytes) => {
    seen.push(bytes)

    // A command that stops reading: head -c N, or tar falling over. The destination errors,
    // which is what the real pipe does when the far end is gone.
    if (stopAfter !== null && Buffer.concat(seen).length >= stopAfter) {
      stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    }
  })

  // A command whose far end is already gone when EOF is signalled. `end()` is where a real pipe
  // reports that, and the error it emits arrives with no write in flight to notice it — so this
  // is the shape that used to take the process down with an unhandled 'error' event.
  if (failOnEof) {
    const realEnd = stdin.end.bind(stdin)

    stdin.end = (...args) => {
      process.nextTick(() =>
        stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })),
      )

      return realEnd(...args)
    }
  }

  const exited = failToStart
    ? Promise.reject(new Error(failToStart))
    : keepRunning
      // A command that has closed its end of the pipe and is still working: `head -c 10` in a
      // shell that has more to do after it. The pipe is gone and no exit status is coming, so
      // the write's own failure is the only thing telstore has to go on.
      ? new Promise(() => {})
      : new Promise((resolve) => stdin.on('close', () => resolve({ code: exitCode, signal })))

  // Attached here for the reason spawnProducer attaches one of its own: a rejected `exited`
  // that nothing is handling yet is an unhandledRejection, and these tests build the child
  // before handing it to a run that will.
  exited.catch(() => {})

  return {
    stdin,
    stdout: null,
    exited,
    kill: () => {
      killed = true
      stdin.destroy()
    },
    bytes: () => Buffer.concat(seen),
    wasKilled: () => killed,
  }
}

async function workspace(settings = { chat: '@store' }) {
  const dir = await tempDir('restore-stream')
  const configDir = path.join(dir, 'config')
  await saveConfig({ ...LOGGED_IN, settings }, configDir)
  return { dir, configDir }
}

function flip(bytes) {
  const changed = Buffer.from(bytes)
  changed[0] ^= 0xff
  return changed
}

// The seam the whole file drives: every dep talks to the fake chat above or to the one fake
// child, and nothing in here knows what Telegram or a process actually is.
function fakeChat(backup, child, ws, overrides = {}) {
  const {
    hideMessageId = null,
    corruptMessageId = null,
    lieAboutSizeOf = null,
    manifestBytes = backup.manifestBytes,
    ...extra
  } = overrides

  const visible = backup.messages.filter((message) => message.id !== hideMessageId)
  const searched = []
  const downloaded = []

  const spawn = (childArgv, options) => {
    spawn.calls.push({ childArgv, options })
    return child
  }
  spawn.calls = []

  const deps = {
    // Handed straight back to the fakes below, which is all the command does with it.
    connect: async () => ({}),
    disconnect: async () => {},
    configDir: ws.configDir,
    silent: true,
    spawn,
    searchManifest: async (_client, _peer, query) => {
      searched.push(query)
      await tick()
      return visible.find((message) => message.fileName === manifestFileName(query)) ?? null
    },
    readMessageBytes: async () => manifestBytes,
    getMessage: async (_client, _peer, msgId) => {
      await tick()
      return visible.find((message) => message.id === msgId) ?? null
    },
    // Writes into the handle it is given and returns the real sha256 of what it wrote, which
    // is what the real one does; the lies it can be asked to tell are the two the manifest
    // checks exist to catch.
    downloadChunk: async (_client, message, handle, offset, onProgress) => {
      downloaded.push(message.id)
      await tick()

      const bytes = message.id === corruptMessageId ? flip(message.bytes) : message.bytes
      await handle.write(bytes, 0, bytes.length, offset)
      onProgress?.(bytes.length)

      return {
        sha256: sha(bytes),
        size: message.id === lieAboutSizeOf ? bytes.length + 1 : bytes.length,
      }
    },
    ...extra,
  }

  return { deps, spawn, searched, downloaded }
}

test('every byte the manifest names reaches the command, in order', async () => {
  const backup = fakeBackup()
  const ws = await workspace()
  const child = fakeChild()
  const { deps, spawn } = fakeChat(backup, child, ws)

  const result = await runRestoreStream(backup.id, ARGV, {}, deps)

  assert.deepEqual(child.bytes(), backup.content)
  assert.deepEqual(result, { id: backup.id, size: 6, chunks: 2 })
  assert.equal(child.wasKilled(), false)

  // stdin is telstore's to write and the command's own output stays the command's. A child whose
  // stdout were piped here would fill a pipe nothing reads and deadlock on it — `tar xzvf -`
  // writes to stdout for a living.
  assert.deepEqual(spawn.calls, [
    { childArgv: ARGV, options: { stdio: ['pipe', 'inherit', 'inherit'] } },
  ])
})

test('nothing is downloaded if the command cannot start', async () => {
  const backup = fakeBackup()
  const ws = await workspace()
  const child = fakeChild({ failToStart: 'Cannot run tar: no such command on this machine.' })
  const { deps, downloaded } = fakeChat(backup, child, ws)

  // The matched string is the fake's own: naming the command that could not be run belongs to
  // spawnProducer and is tested there. What this proves is that the rejection gets out of the run
  // at all rather than being swallowed by the race it is in, and that it gets out before anything
  // has been downloaded.
  await assert.rejects(() => runRestoreStream(backup.id, ARGV, {}, deps), /Cannot run tar/)

  assert.deepEqual(downloaded, [])
  assert.deepEqual(await fs.readdir(tempDirFor(ws.configDir)), [])
})

test('a chunk whose sha256 disagrees with the manifest reaches the command not at all', async () => {
  const backup = fakeBackup()
  const ws = await workspace()
  const child = fakeChild()
  const { deps } = fakeChat(backup, child, ws, {
    corruptMessageId: backup.manifest.chunks[1].msgId,
  })

  await assert.rejects(
    () => runRestoreStream(backup.id, ARGV, {}, deps),
    /Chunk 2 has a sha256 that does not match the manifest\. tar had already been given 4 B/,
  )

  // The whole point: the bad chunk was never written, not that the error was reported
  // afterwards.
  assert.deepEqual(child.bytes(), backup.content.subarray(0, 4))
})

test('a chunk whose length disagrees with the manifest is refused the same way', async () => {
  const backup = fakeBackup()
  const ws = await workspace()
  const child = fakeChild()
  const { deps, downloaded } = fakeChat(backup, child, ws, {
    lieAboutSizeOf: backup.manifest.chunks[0].msgId,
  })

  await assert.rejects(
    () => runRestoreStream(backup.id, ARGV, {}, deps),
    /Chunk 1 arrived with 5 bytes and the manifest records 4 — mismatch\. tar was given nothing\./,
  )

  // On the first chunk, so the command gets nothing at all rather than a correct prefix — and
  // the chunk after the one that failed is never even asked for.
  assert.deepEqual(child.bytes(), Buffer.alloc(0))
  assert.deepEqual(downloaded, [backup.manifest.chunks[0].msgId])
})

test('a chunk message that is gone from the chat fails by name', async () => {
  const backup = fakeBackup()
  const ws = await workspace()
  const child = fakeChild()
  const { deps } = fakeChat(backup, child, ws, { hideMessageId: backup.manifest.chunks[1].msgId })

  await assert.rejects(
    () => runRestoreStream(backup.id, ARGV, {}, deps),
    /Missing chunk 2\/2: message 1001 is no longer in @store/,
  )

  assert.deepEqual(child.bytes(), backup.content.subarray(0, 4))
})

test('a command that stops reading early fails, even though it exited 0', async () => {
  const backup = fakeBackup()
  const ws = await workspace()
  const child = fakeChild({ stopAfter: 4, exitCode: 0 })
  const { deps } = fakeChat(backup, child, ws)

  // The run does not report a restore: a restore reported for a command that saw four bytes
  // of six is the silent wrong answer this project exists not to give.
  //
  // Either wording will do, because which of the two failures is noticed first is a race between
  // the pipe and the exit status and nothing about the guarantee rests on it: both name what was
  // written and what was owed, and neither reports a restore.
  await assert.rejects(
    () => runRestoreStream(backup.id, ARGV, {}, deps),
    /tar (exited 0|stopped reading) with 4 B of 6 B written into it, so it did not receive the backup/,
  )
})

test('a command that closes its stdin and keeps running fails by the same words', async () => {
  // The one ending where there is no exit status to report: the pipe is gone, the command is
  // not, and a write into a dead pipe is all telstore has. A chunk this size does not reach
  // the pipe in one write either, so the failure lands with bytes still in flight.
  const backup = fakeBackup({ chunkSize: 200_000, total: 300_000 })
  const ws = await workspace()
  const child = fakeChild({ stopAfter: 100_000, keepRunning: true })
  const { deps } = fakeChat(backup, child, ws)

  await assert.rejects(
    () => runRestoreStream(backup.id, ARGV, {}, deps),
    /tar stopped reading with .+ of 293\.0 KB written into it, so it did not receive the backup/,
  )

  assert.ok(
    child.bytes().length < backup.content.length,
    'the command should not have received the whole backup',
  )
  // And it is not left running behind a pipe nothing will write to again.
  assert.equal(child.wasKilled(), true)
})

test('a pipe that failed is not reported as a restore, even with the command exiting 0', async () => {
  const backup = fakeBackup()
  const ws = await workspace()
  const child = fakeChild({ exitCode: 0, failOnEof: true })
  const { deps } = fakeChat(backup, child, ws)

  // Two things at once, and the first is why the second can be asserted at all: an 'error' on
  // the child's stdin with nothing listening is an uncaught exception, so a run without the latch
  // takes this whole test process down rather than failing this assertion.
  await assert.rejects(
    () => runRestoreStream(backup.id, ARGV, {}, deps),
    /stdin failed first \(write EPIPE\) — so some of the 6 B telstore wrote into it never arrived/,
  )
})

test('a command that exits non-zero after reading everything fails', async () => {
  const backup = fakeBackup()
  const ws = await workspace()
  const child = fakeChild({ exitCode: 2 })
  const { deps } = fakeChat(backup, child, ws)

  // tar that ran out of disk received every byte and restored nothing.
  await assert.rejects(
    () => runRestoreStream(backup.id, ARGV, {}, deps),
    /tar exited 2 after receiving all 6 B/,
  )

  assert.deepEqual(child.bytes(), backup.content)
})

test('a command killed by a signal fails, and says which', async () => {
  const backup = fakeBackup()
  const ws = await workspace()
  const child = fakeChild({ exitCode: null, signal: 'SIGKILL' })
  const { deps } = fakeChat(backup, child, ws)

  await assert.rejects(
    () => runRestoreStream(backup.id, ARGV, {}, deps),
    /tar was killed by SIGKILL after receiving all 6 B/,
  )
})

test('the manifest is checked against itself before anything is downloaded', async () => {
  const backup = fakeBackup()
  const ws = await workspace()
  const child = fakeChild()
  const broken = JSON.parse(backup.manifestBytes.toString('utf8'))
  broken.chunks[1].size = 1

  const { deps, downloaded, spawn } = fakeChat(backup, child, ws, {
    manifestBytes: Buffer.from(`${JSON.stringify(broken, null, 2)}\n`, 'utf8'),
  })

  await assert.rejects(
    () => runRestoreStream(backup.id, ARGV, {}, deps),
    /add up to 5, but the manifest records a file size of 6/,
  )

  assert.deepEqual(downloaded, [])
  assert.deepEqual(spawn.calls, [])
})

test('the temp chunk file is gone afterwards, on every ending', async () => {
  const backup = fakeBackup()
  const ws = await workspace()
  const tmp = tempDirFor(ws.configDir)

  await runRestoreStream(backup.id, ARGV, {}, fakeChat(backup, fakeChild(), ws).deps)

  // status deliberately never removes one of these, so a run that leaks one leaks it forever.
  assert.deepEqual(await fs.readdir(tmp), [])

  const failing = fakeChat(backup, fakeChild(), ws, {
    corruptMessageId: backup.manifest.chunks[1].msgId,
  })

  await assert.rejects(() => runRestoreStream(backup.id, ARGV, {}, failing.deps), /sha256/)

  assert.deepEqual(await fs.readdir(tmp), [])
})

test('onTempChunk names the file while it exists and unsays it afterwards', async () => {
  const backup = fakeBackup()
  const ws = await workspace()
  const said = []
  const { deps } = fakeChat(backup, fakeChild(), ws, { onTempChunk: (file) => said.push(file) })

  await runRestoreStream(backup.id, ARGV, {}, deps)

  assert.equal(said.length, 4)
  assert.equal(path.basename(said[0]), `${backup.id}-0.chunk`)
  assert.equal(said[1], null)
  assert.equal(path.basename(said[2]), `${backup.id}-1.chunk`)
  assert.equal(said[3], null)
})

test('tarx refuses a backup whose name does not claim gzip, before downloading anything', async () => {
  const backup = fakeBackup({ name: 'a.tar' })
  const ws = await workspace()
  const { deps, searched, downloaded, spawn } = fakeChat(backup, fakeChild(), ws, {
    requireGzipName: true,
  })

  await assert.rejects(() => runRestoreStream(backup.id, ARGV, {}, deps), /tar xf -/)

  // The manifest was read — that is what the check costs — and nothing else happened.
  assert.deepEqual(searched, [backup.id])
  assert.deepEqual(downloaded, [])
  assert.deepEqual(spawn.calls, [])
})

test('a general restore into a command does not care what the name claims', async () => {
  const backup = fakeBackup({ name: 'a.tar' })
  const ws = await workspace()
  const child = fakeChild()
  const { deps } = fakeChat(backup, child, ws)

  const result = await runRestoreStream(backup.id, ARGV, {}, deps)

  assert.deepEqual(child.bytes(), backup.content)
  assert.equal(result.size, 6)
})

test('the command it is feeding is printed, and so is the name it is feeding it', async () => {
  const backup = fakeBackup()
  const ws = await workspace()
  const out = collect()
  const { deps } = fakeChat(backup, fakeChild(), ws, {
    silent: false,
    log: out.log,
    writeErr: () => {},
  })

  await runRestoreStream(backup.id, ARGV, {}, deps)

  // The line that makes the shortcut teach the long form.
  assert.match(out.text(), new RegExp(backup.id))
  assert.match(out.text(), /data\.tar\.gz/)
  assert.match(out.text(), /tar xzf -/)
})
