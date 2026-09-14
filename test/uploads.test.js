import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { runUploads } from '../src/commands/upload.js'

import { saveConfig } from '../src/config.js'
import { parseManifest } from '../src/manifest.js'

import { LOGGED_IN, collect, fakeClient, passwordDeps, tempDir, uploadDeps } from './helpers.js'

// Every file gets its own bytes so a mixed-up chunk shows as a mismatch, not as a pass.
async function tempWorkspace(sizes) {
  const dir = await tempDir('uploads-cmd')
  const files = []

  for (const [i, size] of sizes.entries()) {
    const filePath = path.join(dir, `data-${i}.tar`)
    const content = randomBytes(size)
    await fs.writeFile(filePath, content)
    files.push({ path: filePath, content })
  }

  const configDir = path.join(dir, 'config')
  await saveConfig(LOGGED_IN, configDir)

  return { dir, files, paths: files.map((f) => f.path), configDir }
}

function chunkMessages(client) {
  return client.messages.filter((m) => !m.fileName.endsWith('.manifest.json'))
}

// fakeClient's failOnChunk counts chunks across the whole run, so it cannot name one file in a
// batch. Failing the nth send does: with one chunk per file, the nth send is the nth file.
function failSendAt(client, ...positions) {
  const real = uploadDeps(client)
  let sends = 0

  return {
    ...real,
    sendChunk: async (...args) => {
      sends += 1
      if (positions.includes(sends)) throw new Error('connection dropped mid-transfer')
      return await real.sendChunk(...args)
    },
  }
}

test('every file named on the command line becomes its own backup', async () => {
  const ws = await tempWorkspace([1000, 500])
  const client = fakeClient()

  const { results, failed } = await runUploads(
    ws.paths,
    { chat: '@store', 'chunk-size': '400', 'upload-concurrency': '2', yes: true },
    { ...uploadDeps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  assert.equal(failed, 0)
  assert.equal(results.length, 2)
  assert.notEqual(results[0].id, results[1].id)
  assert.deepEqual(
    results.map((r) => r.chunks),
    [3, 2],
  )

  const sent = chunkMessages(client)
  const first = sent.filter((m) => m.fileName.startsWith(results[0].id))
  const second = sent.filter((m) => m.fileName.startsWith(results[1].id))
  assert.deepEqual(Buffer.concat(first.map((m) => m.bytes)), ws.files[0].content)
  assert.deepEqual(Buffer.concat(second.map((m) => m.bytes)), ws.files[1].content)
})

test('a batch opens one connection and closes it once', async () => {
  const ws = await tempWorkspace([300, 300, 300])
  const client = fakeClient()
  let connects = 0
  let disconnects = 0

  await runUploads(
    ws.paths,
    { chat: '@store', 'chunk-size': '400', yes: true },
    {
      ...uploadDeps(client),
      connect: async () => {
        connects += 1
        return client
      },
      disconnect: async () => {
        disconnects += 1
      },
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
    },
  )

  assert.equal(connects, 1)
  assert.equal(disconnects, 1)
})

test('one file behaves exactly as a single upload, summary and all', async () => {
  const ws = await tempWorkspace([1000])
  const client = fakeClient()
  const out = collect()

  const { results, failed } = await runUploads(
    ws.paths,
    { chat: '@store', 'chunk-size': '400' },
    { ...uploadDeps(client), configDir: ws.configDir, partSize: 128, log: out.log },
  )

  assert.equal(failed, 0)
  assert.equal(results.length, 1)
  assert.match(out.text(), /Done\. Restore with:/)
  assert.doesNotMatch(out.text(), /1 file:/)
})

test('a file that fails does not stop the ones named after it', async () => {
  const ws = await tempWorkspace([300, 300, 300])
  const client = fakeClient()

  const { results, failed } = await runUploads(
    ws.paths,
    { chat: '@store', 'chunk-size': '400', yes: true },
    { ...failSendAt(client, 2), configDir: ws.configDir, partSize: 128, silent: true },
  )

  assert.equal(failed, 1)
  assert.equal(results.length, 3)
  assert.match(results[1].error, /connection dropped/)
  assert.equal(results[1].id, undefined)
  assert.ok(results[0].id && results[2].id)

  // The third file's bytes reached the chat, which is the whole point of carrying on.
  const third = chunkMessages(client).filter((m) => m.fileName.startsWith(results[2].id))
  assert.deepEqual(Buffer.concat(third.map((m) => m.bytes)), ws.files[2].content)
})

test('the summary names every file in the order they were given', async () => {
  const ws = await tempWorkspace([300, 300, 300])
  const client = fakeClient()
  const out = collect()

  const { results } = await runUploads(
    ws.paths,
    { chat: '@store', 'chunk-size': '400', yes: true },
    { ...failSendAt(client, 2), configDir: ws.configDir, partSize: 128, log: out.log },
  )

  const text = out.text()
  assert.match(text, /3 files: 2 uploaded, 1 failed\./)
  assert.match(text, /data-0\.tar\s+telstore-\d{8}-[0-9a-f]{6}/)
  assert.match(text, /data-1\.tar\s+failed: connection dropped mid-transfer/)
  assert.match(text, /data-2\.tar\s+telstore-\d{8}-[0-9a-f]{6}/)
  assert.ok(text.indexOf('data-0.tar  ') < text.indexOf('data-2.tar  '))
  assert.match(text, /Restore with: npx telstore restore/)

  // And each file announces itself before its own transfer starts.
  assert.match(text, /\[2\/3\] data-1\.tar/)
  assert.ok(results.length === 3)
})

test('a batch where everything failed does not offer a restore command', async () => {
  const ws = await tempWorkspace([300, 300])
  const client = fakeClient()
  const out = collect()

  const { failed } = await runUploads(
    ws.paths,
    { chat: '@store', 'chunk-size': '400', yes: true },
    { ...failSendAt(client, 1, 2), configDir: ws.configDir, partSize: 128, log: out.log },
  )

  assert.equal(failed, 2)
  assert.match(out.text(), /2 files: 0 uploaded, 2 failed\./)
  assert.doesNotMatch(out.text(), /Restore with/)
})

test('a file named twice is refused before anything is sent', async () => {
  const ws = await tempWorkspace([300, 300])
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUploads(
        [ws.paths[0], ws.paths[1], ws.paths[0]],
        { chat: '@store', 'chunk-size': '400' },
        { ...uploadDeps(client), configDir: ws.configDir, partSize: 128, silent: true },
      ),
    (err) => {
      assert.match(err.message, /named twice/)
      assert.match(err.message, /data-0\.tar/)
      return true
    },
  )

  assert.equal(client.messages.length, 0)
})

test('a path that does not exist stops the batch before the first byte goes out', async () => {
  const ws = await tempWorkspace([300, 300])
  const client = fakeClient()
  const missing = path.join(ws.dir, 'not-here.tar')

  await assert.rejects(
    () =>
      runUploads(
        [ws.paths[0], missing, ws.paths[1]],
        { chat: '@store', 'chunk-size': '400' },
        { ...uploadDeps(client), configDir: ws.configDir, partSize: 128, silent: true },
      ),
    new RegExp(`File does not exist: ${missing}`),
  )

  assert.equal(client.messages.length, 0)
})

// A folder is now the files inside it, so naming both the folder and one of those files is
// the same mistake as naming a file twice — and it is caught by the same check.
test('a folder named alongside one of its own files is refused as a duplicate', async () => {
  const ws = await tempWorkspace([300])
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUploads(
        [ws.paths[0], ws.dir],
        { chat: '@store', 'chunk-size': '400' },
        { ...uploadDeps(client), configDir: ws.configDir, partSize: 128, silent: true },
      ),
    /named twice/,
  )

  assert.equal(client.messages.length, 0)
})

test('a missing destination is reported once for the batch, not once per file', async () => {
  const ws = await tempWorkspace([300, 300, 300])
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUploads(ws.paths, { 'chunk-size': '400' }, {
        ...uploadDeps(client),
        configDir: ws.configDir,
        partSize: 128,
        silent: true,
      }),
    /No destination set/,
  )

  assert.equal(client.messages.length, 0)
})

test('a batch with no login is refused once, before any backup record is written', async () => {
  const ws = await tempWorkspace([300, 300, 300])
  const client = fakeClient()
  const emptyConfigDir = path.join(ws.dir, 'logged-out')
  let connects = 0

  await assert.rejects(
    () =>
      runUploads(ws.paths, { chat: '@store', 'chunk-size': '400' }, {
        ...uploadDeps(client),
        connect: async () => {
          connects += 1
          return client
        },
        configDir: emptyConfigDir,
        partSize: 128,
        silent: true,
      }),
    /Not logged in/,
  )

  assert.equal(connects, 0)
  assert.equal(client.messages.length, 0)

  // Nothing was sent, so nothing may claim to be resumable either.
  await assert.rejects(() => fs.readdir(path.join(emptyConfigDir, 'state')), { code: 'ENOENT' })
})

test('a file that fails is named as soon as it fails, not only in the summary', async () => {
  const ws = await tempWorkspace([300, 300, 300])
  const client = fakeClient()
  const events = []

  await runUploads(
    ws.paths,
    { chat: '@store', 'chunk-size': '400', yes: true },
    {
      ...failSendAt(client, 2),
      configDir: ws.configDir,
      partSize: 128,
      log: (line) => events.push(['log', line]),
      writeErr: (line) => events.push(['err', line]),
    },
  )

  const failure = events.findIndex(
    ([stream, line]) => stream === 'err' && /data-1\.tar failed: connection dropped/.test(line),
  )
  const nextFile = events.findIndex(([, line]) => String(line).includes('[3/3]'))

  assert.notEqual(failure, -1)
  assert.ok(failure < nextFile, 'the failure must be reported before the next file starts')
})

// --- folders, patterns and the question asked before a batch runs ---

test('a folder is uploaded as the files inside it, one backup each', async () => {
  const ws = await tempWorkspace([300, 300])
  const client = fakeClient()

  const { results, failed } = await runUploads(
    [ws.dir],
    { chat: '@store', 'chunk-size': '400', yes: true },
    { ...uploadDeps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  assert.equal(failed, 0)
  assert.deepEqual(
    results.map((r) => path.basename(r.path)),
    ['data-0.tar', 'data-1.tar'],
  )
})

test('a folder telstore did not walk into is named on stderr, not passed over', async () => {
  const ws = await tempWorkspace([300, 300])
  const client = fakeClient()
  const errors = []

  await runUploads(
    [ws.dir],
    { chat: '@store', 'chunk-size': '400', yes: true },
    {
      ...uploadDeps(client),
      configDir: ws.configDir,
      partSize: 128,
      log: () => {},
      writeErr: (line) => errors.push(line),
    },
  )

  // tempWorkspace keeps its config in a subfolder, which is exactly the case being reported.
  assert.match(errors.join(''), /config/)
  assert.match(errors.join(''), /one level/)
})

test('a pattern that reached telstore intact is expanded the same way', async () => {
  const ws = await tempWorkspace([300, 300])
  const client = fakeClient()

  const { results } = await runUploads(
    [path.join(ws.dir, '*.tar')],
    { chat: '@store', 'chunk-size': '400', yes: true },
    { ...uploadDeps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  assert.deepEqual(
    results.map((r) => path.basename(r.path)),
    ['data-0.tar', 'data-1.tar'],
  )
})

test('a folder holding one file is a single upload, with nothing asked and no summary', async () => {
  const ws = await tempWorkspace([1000])
  const client = fakeClient()
  const out = collect()

  const { results } = await runUploads(
    [ws.dir],
    { chat: '@store', 'chunk-size': '400' },
    {
      ...uploadDeps(client),
      configDir: ws.configDir,
      partSize: 128,
      log: out.log,
      interactive: () => true,
      confirm: async () => {
        throw new Error('a single file must never be confirmed')
      },
    },
  )

  assert.equal(results.length, 1)
  assert.match(out.text(), /Done\. Restore with:/)
  assert.doesNotMatch(out.text(), /1 file:/)
})

test('the question shows every file, its size and where they are going', async () => {
  const ws = await tempWorkspace([300, 1500])
  const client = fakeClient()
  const out = collect()
  const asked = []

  await runUploads(
    ws.paths,
    { chat: '@store', 'chunk-size': '400' },
    {
      ...uploadDeps(client),
      configDir: ws.configDir,
      partSize: 128,
      log: out.log,
      interactive: () => true,
      confirm: async (question) => {
        asked.push(question)
        return true
      },
    },
  )

  const text = out.text()
  assert.match(text, /2 files, 1\.8 KB/)
  assert.match(text, /@store/)
  assert.match(text, /data-0\.tar\s+300 B/)
  assert.match(text, /data-1\.tar\s+1\.5 KB/)
  assert.equal(asked.length, 1)
  assert.match(asked[0], /Upload these 2 files\? \[y\/N\]/)

  // The list has to be on screen before the question is asked, not after it.
  assert.ok(out.lines.length > 0)
})

test('answering anything but yes sends nothing at all', async () => {
  const ws = await tempWorkspace([300, 300])
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUploads(
        ws.paths,
        { chat: '@store', 'chunk-size': '400' },
        {
          ...uploadDeps(client),
          configDir: ws.configDir,
          partSize: 128,
          silent: true,
          interactive: () => true,
          confirm: async () => false,
        },
      ),
    /Cancelled on request/,
  )

  assert.equal(client.messages.length, 0)
})

test('--yes uploads a batch without asking anything', async () => {
  const ws = await tempWorkspace([300, 300])
  const client = fakeClient()

  const { failed } = await runUploads(
    ws.paths,
    { chat: '@store', 'chunk-size': '400', yes: true },
    {
      ...uploadDeps(client),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
      interactive: () => true,
      confirm: async () => {
        throw new Error('--yes must not ask')
      },
    },
  )

  assert.equal(failed, 0)
})

// An empty line read off a pipe is not an answer, and treating it as "no" would make a batch
// in a script fail for a reason nothing on screen explains.
test('with no terminal to ask in, the batch stops and names the flag that goes on', async () => {
  const ws = await tempWorkspace([300, 300])
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUploads(
        ws.paths,
        { chat: '@store', 'chunk-size': '400' },
        {
          ...uploadDeps(client),
          configDir: ws.configDir,
          partSize: 128,
          silent: true,
          interactive: () => false,
          confirm: async () => {
            throw new Error('nothing may be asked without a terminal')
          },
        },
      ),
    /--yes/,
  )

  assert.equal(client.messages.length, 0)
})

// The note is written once and meant for the whole run: `telstore *.tar --note "march"` is
// somebody labelling an evening's work, not the first file of it.
test('a note is stamped on every backup in the batch', async () => {
  const ws = await tempWorkspace([1000, 500])
  const client = fakeClient()

  await runUploads(
    ws.paths,
    { chat: '@store', 'chunk-size': '400', yes: true, note: 'march archive' },
    { ...uploadDeps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  const manifests = client.messages.filter((m) => m.fileName.endsWith('.manifest.json'))

  assert.equal(manifests.length, 2)
  for (const manifest of manifests) {
    assert.equal(JSON.parse(manifest.bytes).note, 'march archive')
  }
})

// One note, one mistake: refusing it per file would report the same problem twice and only
// after the first upload had already finished under a note nobody can now match.
test('a note too long to caption refuses the whole batch', async () => {
  const ws = await tempWorkspace([1000, 500])
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUploads(
        ws.paths,
        { chat: '@store', 'chunk-size': '400', yes: true, note: 'x'.repeat(501) },
        { ...uploadDeps(client), configDir: ws.configDir, partSize: 128, silent: true },
      ),
    /--note is 501 characters/,
  )

  assert.equal(client.messages.length, 0)
})

// The likeliest way a batch gets an extra file is an unquoted note, so the pre-flight refusal
// has to carry the same advice the single-file one does.
test('a missing file in a batch alongside a note names the quoting mistake', async () => {
  const ws = await tempWorkspace([1000, 500])
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUploads(
        [...ws.paths, path.join(ws.dir, 'accounts')],
        { chat: '@store', 'chunk-size': '400', yes: true, note: 'quarterly' },
        {
          ...uploadDeps(client),
          configDir: ws.configDir,
          partSize: 128,
          silent: true,
          filesAfterNote: true,
        },
      ),
    (err) => {
      assert.match(err.message, /does not exist/)
      assert.match(err.message, /--note "/)
      return true
    },
  )

  assert.equal(client.messages.length, 0)
})

test('a batch with --encrypt asks for one password, and every file gets its own salt', async () => {
  const ws = await tempWorkspace([500, 300])
  const client = fakeClient()
  const asked = []

  const { failed } = await runUploads(
    ws.paths,
    { chat: '@store', 'chunk-size': '400', yes: true, encrypt: true },
    { ...uploadDeps(client), ...passwordDeps({ asked }), configDir: ws.configDir, partSize: 128, silent: true },
  )

  assert.equal(failed, 0)
  assert.deepEqual(asked, ['new'])

  const salts = client.messages
    .filter((m) => m.fileName.endsWith('.manifest.json'))
    .map((m) => parseManifest(m.bytes).enc.salt)

  assert.equal(salts.length, 2)
  assert.notEqual(salts[0], salts[1])
})
