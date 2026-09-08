import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { closeQuietly, connect, deleteMessages, findManifestMessage, readMessageBytes } from '../src/client.js'
import { loadConfig, saveConfig } from '../src/config.js'
import { parseManifest } from '../src/manifest.js'
import { LARGE_FILE_THRESHOLD } from '../src/uploader.js'

// Every automated test in test/ talks to a fake client that accepts whatever it is given, so
// the suite cannot see a mismatch with teleproto's real API surface — docs/design/testing-
// blind-spots.md counts the two times that shipped a broken release. This file is the answer
// to the instruction that doc ends with: it uploads, verifies, restores and deletes real
// backups through the real binary, against a real account.
//
// It is deliberately not under test/, so `npm test` — the gate — can never reach a real
// account. `npm run test:e2e` is the only thing that runs it.

const CHAT = process.env.TELSTORE_E2E_CHAT
const BIN = path.join(import.meta.dirname, '..', 'bin', 'telstore.js')
const run = promisify(execFile)

// Telegram splits its upload API at 10MB, and the branch is chosen per chunk, not per file.
// Both sizes are derived from the threshold itself so this test cannot drift away from the
// thing it exists to cover.
const SMALL_CHUNK = Math.floor(LARGE_FILE_THRESHOLD / 4)
const BIG_CHUNK = LARGE_FILE_THRESHOLD + 2 * 1024 * 1024
const MB = 1024 * 1024

// Backups this run put in the chat. Anything still listed here at the end is removed, so a
// failed assertion halfway through does not leave chunks behind — and nothing is ever removed
// that this run did not create.
const created = []

let home = null
let account = null

// The account comes off the machine's own config, but every command runs under a HOME of its
// own: `logout` writes, `config` writes, and a run that wrote to the real ~/.telstore would
// destroy the session of whoever is running the tests. os.homedir() follows $HOME, so this
// one prefix isolates the whole file.
async function isolatedHome() {
  if (home) return home

  const config = await loadConfig()

  if (config.sealed) {
    throw new Error(
      'This machine logged in with a session token, and every command asks for the ' +
        'passphrase. The e2e run has no terminal to type it into — run it on a machine that ' +
        'logged in with "npx telstore login".',
    )
  }

  if (!config.session || !config.apiId || !config.apiHash) {
    throw new Error('Not logged in on this machine — run "npx telstore login" first.')
  }

  account = { apiId: config.apiId, apiHash: config.apiHash, session: config.session }
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'telstore-e2e-'))

  await saveConfig({ ...account, settings: { chat: CHAT } }, path.join(home, '.telstore'))

  return home
}

async function cli(args) {
  const env = { ...process.env, HOME: await isolatedHome() }

  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      env,
      maxBuffer: 32 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

// Random bytes, a megabyte at a time: incompressible, and never the whole file in memory.
async function writeRandom(file, size) {
  const handle = await fs.open(file, 'w')

  try {
    for (let written = 0; written < size; written += MB) {
      await handle.write(randomBytes(Math.min(MB, size - written)))
    }
  } finally {
    await handle.close()
  }
}

async function sha256(file) {
  const hash = createHash('sha256')
  const handle = await fs.open(file, 'r')

  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk)
  } finally {
    await handle.close()
  }

  return hash.digest('hex')
}

function backupIdFrom(stdout) {
  const id = stdout.match(/telstore-\d{8}-[0-9a-f]{6}/)?.[0]

  assert.ok(id, `no backup id in:\n${stdout}`)
  created.push(id)

  return id
}

async function withClient(fn) {
  const client = await connect({ ...account })

  try {
    return await fn(client)
  } finally {
    await closeQuietly(client, (c) => c.destroy())
  }
}

// One backup's whole life through the real binary: split, sent, checked, rebuilt byte for
// byte, and removed again. The hash comparison is the only assertion that matters — every
// other line is here to fail earlier and more clearly when it breaks.
async function roundTrip({ label, size, chunkSize }) {
  const dir = path.join(await isolatedHome(), label)
  await fs.mkdir(dir, { recursive: true })

  const source = path.join(dir, `${label}.bin`)
  await writeRandom(source, size)
  const wanted = await sha256(source)

  const uploaded = await cli(['--chunk-size', String(chunkSize), source])
  assert.equal(uploaded.code, 0, `upload failed:\n${uploaded.stderr}`)

  const id = backupIdFrom(uploaded.stdout)

  const verified = await cli(['verify', id])
  assert.equal(verified.code, 0, `verify failed:\n${verified.stdout}${verified.stderr}`)
  assert.match(verified.stdout, /chunks present/)

  // `list` is deliberately not asserted here, and the reason is a bug this file found on its
  // first run. `list` searches the chat for the literal "#telstore" that manifest captions
  // carry, and in a broadcast channel a query beginning with "#" is answered out of Telegram's
  // hashtag index — which does not hold these messages, because telstore writes captions as
  // plain text with no parse mode, so nothing ever marks that tag as an entity. Measured on
  // 2026-09-07 in the channel these tests run in: "#telstore" returned 0 every time it was
  // asked, while the same chat answered a search for a backup id with both of its messages
  // and a plain document enumeration with all eight. So `list` reports "No backups found"
  // over a chat full of restorable backups.
  //
  // What it is not is a wrong search key that a different string would fix: ".manifest.json"
  // returned every manifest in one session and nothing at all in the next. Until that is
  // designed properly, asserting on `list` here would make this suite flake on a known bug and
  // lie about regressions in everything else. verify below is the check that does hold — it
  // finds the manifest by id, which is the search that never failed.

  const target = path.join(dir, `${label}.restored`)
  const restored = await cli(['restore', id, '--out', target])
  assert.equal(restored.code, 0, `restore failed:\n${restored.stderr}`)
  assert.equal(await sha256(target), wanted, 'restored file is not the file that went up')

  return { id, dir }
}

async function removeBackup(id) {
  const removed = await cli(['delete', id, '--yes'])
  assert.equal(removed.code, 0, `delete failed:\n${removed.stderr}`)

  const index = created.indexOf(id)
  if (index !== -1) created.splice(index, 1)

  return removed
}

const skip = CHAT
  ? false
  : 'set TELSTORE_E2E_CHAT to a chat of your own (it uploads a few MB and deletes them again)'

// Chunks under the 10MB threshold: SaveFilePart and InputFile, three of them, the last one a
// remainder. This case also carries the checks that need a chat to be true in — verify seeing
// a chunk that somebody removed by hand, and seeing a backup that is gone altogether.
test('a backup cut into chunks below the big-file threshold survives a round trip', { skip, timeout: 600_000 }, async () => {
  const { id } = await roundTrip({
    label: 'small-parts',
    size: SMALL_CHUNK * 2 + MB,
    chunkSize: SMALL_CHUNK,
  })

  // What no fake client can be trusted to say: Telegram answers about a deleted message with
  // MessageEmpty rather than leaving it out, and verify reading that as a chunk still sitting
  // in the chat is exactly the silent wrong answer this command exists to prevent.
  const lost = await withClient(async (client) => {
    const message = await findManifestMessage(client, CHAT, id)
    const manifest = parseManifest(await readMessageBytes(client, message))
    const victim = manifest.chunks[1]

    await deleteMessages(client, CHAT, [victim.msgId])

    return victim
  })

  const damaged = await cli(['verify', id])
  assert.equal(damaged.code, 1, 'verify reported a backup missing a chunk as healthy')
  assert.match(damaged.stdout, /Chunk 2\/3 is gone/)
  assert.match(damaged.stdout, /1 damaged\. This backup cannot be restored\./)
  assert.ok(lost.msgId > 0)

  await removeBackup(id)

  const gone = await cli(['verify', id])
  assert.equal(gone.code, 1)
  assert.match(gone.stderr, new RegExp(`No backup ${id} found`))
})

// A chunk above the threshold: SaveBigFilePart and InputFileBig, with a remainder chunk
// below it in the same backup, so one upload crosses the branch both ways.
test('a backup with a chunk above the big-file threshold survives a round trip', { skip, timeout: 600_000 }, async () => {
  const { id } = await roundTrip({
    label: 'big-parts',
    size: BIG_CHUNK + MB,
    chunkSize: BIG_CHUNK,
  })

  await removeBackup(id)
})

// Best effort, and only ever for ids this run created: an assertion that threw halfway
// through must not leave someone's chat holding chunks nobody will think to look for.
after(async () => {
  for (const id of [...created]) {
    const removed = await cli(['delete', id, '--yes'])

    if (removed.code !== 0) {
      process.stderr.write(
        `\nCould not clean up ${id}: ${removed.stderr}\nRemove it by hand with ` +
          `"npx telstore delete ${id}".\n`,
      )
    }
  }

  if (home) await fs.rm(home, { recursive: true, force: true })
})
