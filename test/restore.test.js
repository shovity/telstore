import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { runRestore, realDownloadChunk } from '../src/commands/restore.js'
import { buildManifest, serializeManifest, manifestFileName } from '../src/manifest.js'
import { saveConfig } from '../src/config.js'
import { restoreFile, restoreKey } from '../src/state.js'
import { createProgress } from '../src/progress.js'
import { DEFAULT_DOWNLOAD_CONCURRENCY } from '../src/chunking.js'

import { collect, tempDir } from './helpers.js'

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Builds a fake "chat" holding the chunks and manifest of one backup.
 */
function fakeBackup({ id = 'telstore-20260905-7f3a91', name = 'data.tar', chunkSize = 400, total = 1000 } = {}) {
  const content = randomBytes(total)
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

function fakeClient(backup, { hideMessageId = null, corruptMessageId = null, truncateMessageId = null } = {}) {
  const visible = backup.messages.filter((m) => m.id !== hideMessageId)

  return {
    async searchManifest(peer, query) {
      return visible.find((m) => m.fileName === `${query}.manifest.json`) ?? null
    },
    async readMessageBytes(message) {
      return message.bytes
    },
    async getMessage(peer, msgId) {
      return visible.find((m) => m.id === msgId) ?? null
    },
    iterDownload(file) {
      let bytes = file.bytes
      if (file.id === corruptMessageId) bytes = randomBytes(file.bytes.length)
      if (file.id === truncateMessageId) bytes = file.bytes.subarray(0, file.bytes.length - 10)
      return (async function* () {
        yield bytes
      })()
    },
  }
}

function deps(client, configDir) {
  return {
    connect: async () => client,
    disconnect: async () => {},
    configDir,
    silent: true,
    searchManifest: (c, peer, query) => c.searchManifest(peer, query),
    readMessageBytes: (c, message) => c.readMessageBytes(message),
    getMessage: (c, peer, msgId) => c.getMessage(peer, msgId),
    downloadChunk: async (c, message, handle, offset, onProgress) => {
      const hash = createHash('sha256')
      let written = 0
      for await (const buf of c.iterDownload({ id: message.id, bytes: message.bytes })) {
        await handle.write(buf, 0, buf.length, offset + written)
        hash.update(buf)
        written += buf.length
        onProgress?.(buf.length)
      }
      return { sha256: hash.digest('hex'), size: written }
    },
  }
}

// Records which chunk messages a run actually fetched. A resumed restore is only
// resumed if it never asked for the chunks it claims to have skipped.
function watchGetMessage(base, asked) {
  return {
    ...base,
    getMessage: (c, peer, msgId) => {
      asked.push(msgId)
      return c.getMessage(peer, msgId)
    },
  }
}

async function tempConfig(chat = '@store') {
  const dir = await tempDir('restore')
  const configDir = path.join(dir, 'config')
  await saveConfig({ apiId: 1, apiHash: 'h', session: 's', settings: { chat } }, configDir)
  return { dir, configDir }
}

test('reassembles the original file exactly', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  const result = await runRestore(backup.id, { out }, deps(fakeClient(backup), configDir))

  assert.equal(result.path, out)
  assert.equal(result.size, 1000)
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('without --out it uses the name from the manifest', async () => {
  const backup = fakeBackup({ name: 'backup.tar' })
  const { dir, configDir } = await tempConfig()
  const cwd = process.cwd()
  process.chdir(dir)

  try {
    const result = await runRestore(backup.id, {}, deps(fakeClient(backup), configDir))
    assert.equal(path.basename(result.path), 'backup.tar')
    assert.deepEqual(await fs.readFile(result.path), backup.content)
  } finally {
    process.chdir(cwd)
  }
})

test('leaves no .partial file behind on success', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  await runRestore(backup.id, { out }, deps(fakeClient(backup), configDir))

  const files = await fs.readdir(dir)
  assert.ok(!files.some((f) => f.endsWith('.partial')), `left behind: ${files.join(', ')}`)
})

test('a missing manifest is reported with the backup id', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const client = fakeClient(backup, { hideMessageId: 2000 })

  await assert.rejects(
    () => runRestore(backup.id, { out: path.join(dir, 'out.tar') }, deps(client, configDir)),
    new RegExp(backup.id),
  )
})

test('a missing chunk stops immediately and names which one', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const client = fakeClient(backup, { hideMessageId: 1001 })

  await assert.rejects(
    () => runRestore(backup.id, { out: path.join(dir, 'out.tar') }, deps(client, configDir)),
    /chunk 2\/3/,
  )
})

test('a sha256 mismatch errors and keeps the .partial file for inspection', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const client = fakeClient(backup, { corruptMessageId: 1001 })

  await assert.rejects(() => runRestore(backup.id, { out }, deps(client, configDir)), /does not match/)

  const files = await fs.readdir(dir)
  assert.ok(files.includes('out.tar.partial'))
  assert.ok(!files.includes('out.tar'))
})

test('an existing target is not overwritten unless confirmed', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  await fs.writeFile(out, 'old data')

  await assert.rejects(
    () => runRestore(backup.id, { out }, { ...deps(fakeClient(backup), configDir), confirm: async () => false }),
    /Cancelled/,
  )

  assert.equal(await fs.readFile(out, 'utf8'), 'old data')

  await runRestore(backup.id, { out }, { ...deps(fakeClient(backup), configDir), confirm: async () => true })
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('a path-traversing name in the manifest still writes into the current directory', async () => {
  const backup = fakeBackup({ name: '../../etc/evil.tar' })
  const { dir, configDir } = await tempConfig()
  const cwd = process.cwd()
  process.chdir(dir)

  try {
    const result = await runRestore(backup.id, {}, deps(fakeClient(backup), configDir))
    assert.equal(path.dirname(result.path), dir)
    assert.equal(path.basename(result.path), 'evil.tar')
    assert.deepEqual(await fs.readFile(result.path), backup.content)
  } finally {
    process.chdir(cwd)
  }
})

test('chunk progress tracks the downloaded data instead of sticking at 0%', async () => {
  const bytes = randomBytes(900)
  const document = { size: bytes.length }
  const message = { id: 1, media: { document } }

  const client = {
    iterDownload(file) {
      assert.equal(file, message.media)
      return (async function* () {
        yield bytes.subarray(0, 300)
        yield bytes.subarray(300, 600)
        yield bytes.subarray(600, 900)
      })()
    },
  }

  const dir = await tempDir('progress')
  const handle = await fs.open(path.join(dir, 'out.bin'), 'w+')
  await handle.truncate(900)

  const lines = []
  let tick = 0
  const progress = createProgress({
    total: 900,
    label: 'Chunk 1/1',
    write: (line) => lines.push(line),
    now: () => (tick += 300),
    minIntervalMs: 0,
  })

  try {
    const result = await realDownloadChunk(client, message, handle, 0, progress.advance)
    progress.finish()

    assert.equal(result.size, 900)
    assert.equal(result.sha256, sha(bytes))

    const percents = lines.map((line) => Number(line.match(/(\d+)%/)[1]))
    assert.ok(
      percents.some((p) => p > 0 && p < 100),
      `no line shows intermediate progress (>0% and <100%): ${lines.join(' | ')}`,
    )
    assert.equal(percents.at(-1), 100, `the last line must be 100%: ${lines.join(' | ')}`)
  } finally {
    await handle.close()
  }
})

test('a short chunk reports the byte counts, not just a sha256 mismatch', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const client = fakeClient(backup, { truncateMessageId: 1001 })

  await assert.rejects(
    () => runRestore(backup.id, { out }, deps(client, configDir)),
    /Chunk 2 has 390 bytes, the manifest records 400 bytes/,
  )

  const files = await fs.readdir(dir)
  assert.ok(files.includes('out.tar.partial'), 'the .partial is kept for inspection')
  assert.ok(!files.includes('out.tar'), 'it must not be renamed into the real file')
})

test('a manifest name of ".." is rejected with a pointer to --out', async () => {
  const backup = fakeBackup({ name: '..' })
  const { dir, configDir } = await tempConfig()

  // Run inside a subdirectory so the parent ("..") is a directory we own, rather than
  // os.tmpdir(), which the test files running in parallel also write into.
  const workDir = path.join(dir, 'work')
  await fs.mkdir(workDir)
  const before = new Set(await fs.readdir(dir))

  const cwd = process.cwd()
  process.chdir(workDir)

  try {
    await assert.rejects(() => runRestore(backup.id, {}, deps(fakeClient(backup), configDir)), /--out/)

    const created = (await fs.readdir(dir)).filter((f) => !before.has(f))
    assert.deepEqual(created, [], `nothing may be created in the parent, but found: ${created.join(', ')}`)
  } finally {
    process.chdir(cwd)
  }
})

test('a manifest name of "." or empty is rejected too', async () => {
  for (const name of ['.', '', '/']) {
    const backup = fakeBackup({ name })
    const { dir, configDir } = await tempConfig()
    const cwd = process.cwd()
    process.chdir(dir)

    try {
      await assert.rejects(
        () => runRestore(backup.id, {}, deps(fakeClient(backup), configDir)),
        /--out/,
        `the name ${JSON.stringify(name)} must be rejected`,
      )
    } finally {
      process.chdir(cwd)
    }
  }
})

test('an assembled file of the wrong length errors instead of being renamed', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  // Simulate a layout bug: the last chunk is written 100 bytes too far along, but
  // still reports the right size and sha256, so every per-chunk check passes.
  const base = deps(fakeClient(backup), configDir)
  const skewed = {
    ...base,
    downloadChunk: (c, message, handle, offset, onProgress) =>
      base.downloadChunk(c, message, handle, message.id === 1002 ? offset + 100 : offset, onProgress),
  }

  await assert.rejects(
    () => runRestore(backup.id, { out }, skewed),
    /The assembled file has 1100 bytes, the manifest records 1000 bytes/,
  )

  const files = await fs.readdir(dir)
  assert.ok(files.includes('out.tar.partial'))
  assert.ok(!files.includes('out.tar'))
})

test('every chunk download is handed retry options it can announce through', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const base = deps(fakeClient(backup), configDir)
  const handed = []

  await runRestore(backup.id, { out }, {
    ...base,
    downloadChunk: (c, message, handle, offset, onProgress, options) => {
      handed.push(options.retryOptions)
      return base.downloadChunk(c, message, handle, offset, onProgress)
    },
  })

  assert.equal(handed.length, backup.manifest.chunks.length)
  for (const options of handed) {
    assert.equal(typeof options?.onRetry, 'function', 'a retry nobody can see reads as a hang')
  }
})

// A 4.3GB restore throws off a handful of -503s that each recover on the next try. One line
// per occurrence buries the progress bar, so the first two are swallowed and the third —
// which has outlived two backoffs — is spoken.
test('the first two retries are swallowed and the third is announced', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const base = deps(fakeClient(backup), configDir)
  const written = []

  await runRestore(backup.id, { out }, {
    ...base,
    silent: false,
    log: () => {},
    writeErr: (line) => written.push(line),
    downloadChunk: (c, message, handle, offset, onProgress, options) => {
      const err = new Error('-503: Timeout (caused by upload.GetFile)')
      options.retryOptions.onRetry(err, 1, 1000, 200)
      options.retryOptions.onRetry(err, 2, 2000, 200)
      options.retryOptions.onRetry(err, 3, 4000, 200)
      return base.downloadChunk(c, message, handle, offset, onProgress)
    },
  })

  const text = written.join('')
  assert.doesNotMatch(text, /retry 1 /)
  assert.doesNotMatch(text, /retry 2 /)
  assert.match(text, /Timeout/)
  assert.match(text, /retry 3 /)
})

// The exception the quiet must not swallow: an attempt that took a minute to fail already
// left the bar frozen for a minute, which reads as the hang src/stall.js exists to end.
test('an attempt that took a minute to fail is announced on the first retry', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const base = deps(fakeClient(backup), configDir)
  const written = []

  await runRestore(backup.id, { out }, {
    ...base,
    silent: false,
    log: () => {},
    writeErr: (line) => written.push(line),
    downloadChunk: (c, message, handle, offset, onProgress, options) => {
      options.retryOptions.onRetry(new Error('Telegram stopped sending slice 3/9'), 1, 1000, 60_000)
      return base.downloadChunk(c, message, handle, offset, onProgress)
    },
  })

  const text = written.join('')
  assert.match(text, /stopped sending slice 3\/9/)
  assert.match(text, /retry 1 /)
})

test('a wait longer than a minute says telstore is waiting, not stuck', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const base = deps(fakeClient(backup), configDir)
  const written = []

  await runRestore(backup.id, { out }, {
    ...base,
    silent: false,
    log: () => {},
    writeErr: (line) => written.push(line),
    downloadChunk: (c, message, handle, offset, onProgress, options) => {
      options.retryOptions.onRetry(new Error('FLOOD_WAIT_3600'), 1, 3_600_000)
      return base.downloadChunk(c, message, handle, offset, onProgress)
    },
  })

  const text = written.join('')
  assert.match(text, /1h/)
  assert.match(text, /leave it running/)
})

test('realDownloadChunk carries the retry options through to the downloader', async () => {
  const backup = fakeBackup({ total: 100, chunkSize: 100 })
  const dir = await tempDir('restore')
  const handle = await fs.open(path.join(dir, 'out.bin'), 'w+')
  const attempts = []
  let failed = false

  const client = {
    iterDownload(file, params) {
      const from = Number(params.offset ?? 0)
      return (async function* () {
        if (!failed) {
          failed = true
          throw new Error('-503: Timeout (caused by upload.GetFile)')
        }
        yield backup.content.subarray(from)
      })()
    },
  }

  const result = await realDownloadChunk(
    client,
    { id: 1, media: { document: { id: 'd', size: backup.content.length } } },
    handle,
    0,
    () => {},
    { retryOptions: { baseDelayMs: 0, sleep: async () => {}, onRetry: (err) => attempts.push(err.message) } },
  )

  await handle.close()
  assert.equal(result.size, 100)
  assert.deepEqual(attempts, ['-503: Timeout (caused by upload.GetFile)'])
})

test('restore draws one bar for the whole file, not one per chunk', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const written = []

  await runRestore(backup.id, { out }, {
    ...deps(fakeClient(backup), configDir),
    silent: false,
    log: () => {},
    writeErr: (line) => written.push(line),
  })

  const text = written.join('')
  assert.match(text, /Chunk 1\/3/)
  assert.match(text, /Chunk 2\/3/)
  assert.match(text, /Chunk 3\/3/)

  assert.equal(
    written.filter((line) => line.endsWith('\n')).length,
    1,
    'the bar owns one line for the whole restore',
  )
  assert.ok(
    written.every((line) => line.includes('/1000 B')),
    'the total is the file, never the chunk in flight',
  )
  assert.doesNotMatch(text, /\/400 B/)

  const percents = written.map((line) => Number(line.match(/(\d+)%/)[1]))

  for (let i = 1; i < percents.length; i += 1) {
    assert.ok(percents[i] >= percents[i - 1], `${percents[i]}% came after ${percents[i - 1]}%`)
  }

  assert.deepEqual(percents.at(0), 0)
  assert.ok(percents.includes(40), 'the bar carries chunk 1 over into chunk 2')
  assert.ok(percents.includes(80), 'the bar carries chunk 2 over into chunk 3')
  assert.equal(percents.at(-1), 100)
})

test('a chunk that fails still closes the bar line before the error', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const written = []

  await assert.rejects(
    runRestore(backup.id, { out }, {
      ...deps(fakeClient(backup, { truncateMessageId: 1001 }), configDir),
      silent: false,
      log: () => {},
      writeErr: (line) => written.push(line),
    }),
    /Chunk 2 has 390 bytes/,
  )

  assert.match(
    written.at(-1),
    /\n$/,
    'the cursor is left on a fresh line so the error does not land on the bar',
  )
  assert.doesNotMatch(written.at(-1), /100%/)
})

// A restore that ignored the setting would still reassemble the file, so nothing else in
// this suite would notice: the only evidence is what reaches the pool.
test('restore hands the download pool the size the flag asked for', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const base = deps(fakeClient(backup), configDir)
  const seen = []

  await runRestore(
    backup.id,
    { out: path.join(dir, 'out.tar'), 'download-concurrency': '3' },
    {
      ...base,
      downloadChunk: (c, message, handle, offset, onProgress, options) => {
        seen.push(options?.concurrency)
        return base.downloadChunk(c, message, handle, offset, onProgress)
      },
    },
  )

  assert.deepEqual(seen, backup.manifest.chunks.map(() => 3))
})

test('with no flag the download pool gets the built-in default', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const base = deps(fakeClient(backup), configDir)
  const seen = []

  await runRestore(
    backup.id,
    { out: path.join(dir, 'out.tar') },
    {
      ...base,
      downloadChunk: (c, message, handle, offset, onProgress, options) => {
        seen.push(options?.concurrency)
        return base.downloadChunk(c, message, handle, offset, onProgress)
      },
    },
  )

  assert.deepEqual(seen, backup.manifest.chunks.map(() => DEFAULT_DOWNLOAD_CONCURRENCY))
})

test('resumes from a .partial that already holds the first chunks', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  const partial = Buffer.alloc(1000)
  backup.content.copy(partial, 0, 0, 800)
  await fs.writeFile(`${out}.partial`, partial)

  const asked = []
  await runRestore(backup.id, { out }, watchGetMessage(deps(fakeClient(backup), configDir), asked))

  assert.deepEqual(asked, [1002])
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('a corrupt region in the .partial re-downloads it and everything after it', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  // Every byte is right except one inside chunk 2. Chunk 3 is byte-perfect and is
  // still re-fetched: what is already there is a prefix, and the scan stops at the
  // first thing it cannot vouch for rather than picking survivors out of the middle.
  const partial = Buffer.from(backup.content)
  partial[500] ^= 0xff
  await fs.writeFile(`${out}.partial`, partial)

  const asked = []
  await runRestore(backup.id, { out }, watchGetMessage(deps(fakeClient(backup), configDir), asked))

  assert.deepEqual(asked, [1001, 1002])
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('a .partial shorter than the file resumes at the right chunk', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  await fs.writeFile(`${out}.partial`, backup.content.subarray(0, 400))

  const asked = []
  await runRestore(backup.id, { out }, watchGetMessage(deps(fakeClient(backup), configDir), asked))

  assert.deepEqual(asked, [1001, 1002])
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('a .partial matching nothing is downloaded over from the start', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  await fs.writeFile(`${out}.partial`, randomBytes(1000))

  const asked = []
  await runRestore(backup.id, { out }, watchGetMessage(deps(fakeClient(backup), configDir), asked))

  assert.deepEqual(asked, [1000, 1001, 1002])
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('a complete .partial is renamed without downloading anything', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  // What a run that died between its last chunk and the rename leaves behind.
  await fs.writeFile(`${out}.partial`, backup.content)

  const asked = []
  await runRestore(backup.id, { out }, watchGetMessage(deps(fakeClient(backup), configDir), asked))

  assert.deepEqual(asked, [])
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('a fresh restore never scans for anything to resume', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const seen = collect()

  await runRestore(backup.id, { out }, {
    ...deps(fakeClient(backup), configDir),
    silent: false,
    log: seen.log,
    writeErr: () => {},
  })

  assert.doesNotMatch(seen.text(), /Checking what is already/)
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('a .partial that cannot be opened stops the restore rather than starting over', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  // A directory where the .partial belongs: open fails with something that is not ENOENT.
  // Treating that as "no file yet" would truncate nothing, download everything, and fail
  // only at the rename — two hours later, for a reason nobody could read off the error.
  await fs.mkdir(`${out}.partial`)

  await assert.rejects(() => runRestore(backup.id, { out }, deps(fakeClient(backup), configDir)))
})

test('a resumed restore names the chunks it skipped', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const seen = collect()

  const partial = Buffer.alloc(1000)
  backup.content.copy(partial, 0, 0, 400)
  await fs.writeFile(`${out}.partial`, partial)

  await runRestore(backup.id, { out }, {
    ...deps(fakeClient(backup), configDir),
    silent: false,
    log: seen.log,
    writeErr: () => {},
  })

  assert.match(seen.text(), /Chunk 1\/3 already restored, skipping\./)
  assert.doesNotMatch(seen.text(), /Chunk 2\/3 already restored/)
})

test('the record tracks an unfinished restore and is gone once it finishes', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const key = restoreKey(backup.id, out)
  const seen = []

  const base = deps(fakeClient(backup), configDir)

  await runRestore(backup.id, { out }, {
    ...base,
    downloadChunk: async (...args) => {
      seen.push(JSON.parse(await fs.readFile(restoreFile(key, configDir), 'utf8')))
      return await base.downloadChunk(...args)
    },
  })

  assert.equal(seen.length, 3)
  assert.deepEqual(seen.map((record) => record.done), [0, 1, 2])
  assert.equal(seen[0].id, backup.id)
  assert.equal(seen[0].target, out)
  assert.equal(seen[0].chat, '@store')
  assert.equal(seen[0].size, 1000)
  assert.equal(seen[0].chunks, 3)

  await assert.rejects(() => fs.stat(restoreFile(key, configDir)), { code: 'ENOENT' })
})

test('a resumed restore records the chunks it found rather than starting the count over', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const key = restoreKey(backup.id, out)

  const partial = Buffer.alloc(1000)
  backup.content.copy(partial, 0, 0, 800)
  await fs.writeFile(`${out}.partial`, partial)

  const base = deps(fakeClient(backup), configDir)
  let first = null

  await runRestore(backup.id, { out }, {
    ...base,
    downloadChunk: async (...args) => {
      first ??= JSON.parse(await fs.readFile(restoreFile(key, configDir), 'utf8'))
      return await base.downloadChunk(...args)
    },
  })

  assert.equal(first.done, 2)
})

test('a record that cannot be written does not fail the restore', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  // A file where the state directory belongs: every write under it fails, whoever is
  // running the tests. The restore is still a restore.
  await fs.writeFile(path.join(configDir, 'state'), 'not a directory')

  const warnings = collect()

  const result = await runRestore(backup.id, { out }, {
    ...deps(fakeClient(backup), configDir),
    silent: false,
    log: () => {},
    writeErr: warnings.log,
  })

  assert.equal(result.size, 1000)
  assert.deepEqual(await fs.readFile(out), backup.content)
  assert.match(warnings.text(), /could not record restore progress/)
})
