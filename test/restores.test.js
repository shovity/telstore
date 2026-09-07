import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { runRestores } from '../src/commands/restore.js'
import { buildManifest, serializeManifest, manifestFileName } from '../src/manifest.js'
import { saveConfig } from '../src/config.js'

import { LOGGED_IN, collect, tempDir } from './helpers.js'

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

// One chat holding several backups, each with its own bytes so a mixed-up chunk shows up as a
// mismatch rather than as a pass.
function fakeChat(names) {
  const messages = []
  const backups = []
  let nextId = 1000

  for (const [index, name] of names.entries()) {
    const id = `telstore-2026090${index + 1}-00000${index + 1}`
    const content = randomBytes(500)
    const msgId = (nextId += 1)

    messages.push({ id: msgId, fileName: `${id}.part0001`, bytes: content })

    const manifest = buildManifest({
      id,
      name,
      size: content.length,
      chunkSize: 500,
      chunks: [{ i: 0, msgId, size: content.length, sha256: sha(content) }],
    })

    messages.push({ id: (nextId += 1), fileName: manifestFileName(id), bytes: serializeManifest(manifest) })
    backups.push({ id, name, content })
  }

  return { messages, backups, ids: backups.map((b) => b.id) }
}

function deps(chat, configDir, { hideManifestOf = null } = {}) {
  const visible = chat.messages.filter(
    (m) => m.fileName !== (hideManifestOf ? manifestFileName(hideManifestOf) : null),
  )

  return {
    connect: async () => ({}),
    disconnect: async () => {},
    configDir,
    silent: true,
    searchManifest: async (client, peer, query) =>
      visible.find((m) => m.fileName === `${query}.manifest.json`) ?? null,
    readMessageBytes: async (client, message) => message.bytes,
    getMessage: async (client, peer, msgId) => visible.find((m) => m.id === msgId) ?? null,
    downloadChunk: async (client, message, handle, offset, onProgress) => {
      await handle.write(message.bytes, 0, message.bytes.length, offset)
      onProgress?.(message.bytes.length)
      return { sha256: sha(message.bytes), size: message.bytes.length }
    },
  }
}

async function workspace(chatOption = { chat: '@store' }) {
  const dir = await tempDir('restores')
  const configDir = path.join(dir, 'config')
  await saveConfig({ ...LOGGED_IN, settings: chatOption }, configDir)
  return { dir, configDir }
}

// Several ids means several files, and without --out each one is named by its own manifest —
// so the run has to happen somewhere, and that somewhere is a temp directory.
async function inDir(dir, run) {
  const cwd = process.cwd()
  process.chdir(dir)

  try {
    return await run()
  } finally {
    process.chdir(cwd)
  }
}

test('every id becomes its own file, named by its own manifest', async () => {
  const chat = fakeChat(['a.tar', 'b.tar'])
  const { dir, configDir } = await workspace()

  const { results, failed } = await inDir(dir, () =>
    runRestores(chat.ids, {}, deps(chat, configDir)),
  )

  assert.equal(failed, 0)
  assert.deepEqual(
    results.map((r) => path.basename(r.path)),
    ['a.tar', 'b.tar'],
  )
  assert.deepEqual(await fs.readFile(path.join(dir, 'a.tar')), chat.backups[0].content)
  assert.deepEqual(await fs.readFile(path.join(dir, 'b.tar')), chat.backups[1].content)
})

test('a batch opens one connection and closes it once', async () => {
  const chat = fakeChat(['a.tar', 'b.tar', 'c.tar'])
  const { dir, configDir } = await workspace()
  let connects = 0
  let disconnects = 0

  await inDir(dir, () =>
    runRestores(chat.ids, {}, {
      ...deps(chat, configDir),
      connect: async () => {
        connects += 1
        return {}
      },
      disconnect: async () => {
        disconnects += 1
      },
    }),
  )

  assert.equal(connects, 1)
  assert.equal(disconnects, 1)
})

test('one id restores exactly as a single restore does, --out and all', async () => {
  const chat = fakeChat(['a.tar'])
  const { dir, configDir } = await workspace()
  const out = path.join(dir, 'elsewhere.tar')
  const log = collect()

  const { results, failed } = await runRestores(chat.ids, { out }, {
    ...deps(chat, configDir),
    silent: false,
    log: log.log,
    writeErr: () => {},
  })

  assert.equal(failed, 0)
  assert.equal(results[0].path, out)
  assert.deepEqual(await fs.readFile(out), chat.backups[0].content)
  assert.match(log.text(), /Done\. Wrote/)
  assert.doesNotMatch(log.text(), /1 backup:/)
})

test('--out with more than one id is refused before anything is downloaded', async () => {
  const chat = fakeChat(['a.tar', 'b.tar'])
  const { dir, configDir } = await workspace()
  let connects = 0

  await assert.rejects(
    () =>
      runRestores(chat.ids, { out: path.join(dir, 'one.tar') }, {
        ...deps(chat, configDir),
        connect: async () => {
          connects += 1
          return {}
        },
      }),
    /--out/,
  )

  assert.equal(connects, 0)
  assert.deepEqual(await fs.readdir(dir), ['config'])
})

test('the same id twice is refused rather than restored over itself', async () => {
  const chat = fakeChat(['a.tar'])
  const { dir, configDir } = await workspace()

  await assert.rejects(
    () => inDir(dir, () => runRestores([chat.ids[0], chat.ids[0]], {}, deps(chat, configDir))),
    /named twice/,
  )
})

test('a batch with no login is refused once, before any connection', async () => {
  const chat = fakeChat(['a.tar', 'b.tar'])
  const dir = await tempDir('restores-logged-out')
  const configDir = path.join(dir, 'config')
  await saveConfig({ settings: { chat: '@store' } }, configDir)
  let connects = 0

  await assert.rejects(
    () =>
      runRestores(chat.ids, {}, {
        ...deps(chat, configDir),
        configDir,
        connect: async () => {
          connects += 1
          return {}
        },
      }),
    /Not logged in/,
  )

  assert.equal(connects, 0)
})

test('an id that cannot be restored does not stop the ones after it', async () => {
  const chat = fakeChat(['a.tar', 'b.tar', 'c.tar'])
  const { dir, configDir } = await workspace()
  const out = collect()

  const { results, failed } = await inDir(dir, () =>
    runRestores(chat.ids, {}, {
      ...deps(chat, configDir, { hideManifestOf: chat.ids[1] }),
      silent: false,
      log: out.log,
      writeErr: () => {},
    }),
  )

  assert.equal(failed, 1)
  assert.equal(results.length, 3)
  assert.match(results[1].error, /No manifest found/)
  assert.deepEqual(await fs.readFile(path.join(dir, 'c.tar')), chat.backups[2].content)

  const text = out.text()
  assert.match(text, /3 backups: 2 restored, 1 failed\./)
  assert.match(text, new RegExp(`${chat.ids[1]}\\s+failed: No manifest found`))
  assert.match(text, /\[2\/3\] telstore-/)
})

test('a failing id is named the moment it fails, not only in the summary', async () => {
  const chat = fakeChat(['a.tar', 'b.tar', 'c.tar'])
  const { dir, configDir } = await workspace()
  const events = []

  await inDir(dir, () =>
    runRestores(chat.ids, {}, {
      ...deps(chat, configDir, { hideManifestOf: chat.ids[1] }),
      silent: false,
      log: (line) => events.push(['log', line]),
      writeErr: (line) => events.push(['err', line]),
    }),
  )

  const failure = events.findIndex(
    ([stream, line]) => stream === 'err' && new RegExp(`${chat.ids[1]} failed:`).test(line),
  )
  const nextId = events.findIndex(([, line]) => String(line).includes('[3/3]'))

  assert.notEqual(failure, -1)
  assert.ok(failure < nextId, 'the failure must be reported before the next id starts')
})

test('a batch reports each id as it finishes', async () => {
  const chat = fakeChat(['a.tar', 'b.tar'])
  const { dir, configDir } = await workspace()
  const cwd = process.cwd()
  const finished = []

  // No --out in a batch: each file is named by its own manifest, in the current directory.
  process.chdir(dir)

  try {
    await runRestores(chat.ids, {}, {
      ...deps(chat, configDir),
      onRestoreDone: (item) => finished.push(item),
    })
  } finally {
    process.chdir(cwd)
  }

  assert.deepEqual(finished.map((item) => item.id), chat.ids)
  assert.deepEqual(finished.map((item) => path.basename(item.path)), ['a.tar', 'b.tar'])
})
