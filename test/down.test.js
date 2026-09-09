import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { runDown } from '../src/commands/down.js'
import { configFile, saveConfig } from '../src/config.js'
import {
  restoreKey,
  saveRestore,
  saveState,
  stateDir,
  stateKey,
  streamKey,
  tempDirFor,
} from '../src/state.js'
import { LOGGED_IN, collect, tempDir } from './helpers.js'

// Every test drives the question rather than a terminal: `confirm` that throws is how a test
// says "this must not ask", and `interactive` is injected so nothing depends on whether the
// suite happens to be running under a tty.
const YES = { confirm: async () => true, interactive: () => true }
const NEVER_ASKS = {
  confirm: async () => {
    throw new Error('should not have asked')
  },
  interactive: () => true,
}

async function gone(dir) {
  try {
    await fs.stat(dir)
    return false
  } catch (err) {
    return err.code === 'ENOENT'
  }
}

async function anUpload(configDir, { id, file, chat = 'me' }) {
  const key = stateKey(file, 10, 20)
  await saveState(key, { id, path: file, size: 10, chunkSize: 10, chat, done: {} }, configDir)
  return key
}

async function aStream(configDir, { id, name, chat = 'me', ...rest }) {
  const key = streamKey(id)
  await saveState(
    key,
    { v: 1, kind: 'stream', id, name, chat, chunkSize: 10, done: {}, ...rest },
    configDir,
  )
  return key
}

async function aRestore(configDir, { id, target, chat = 'me' }) {
  const key = restoreKey(id, target)
  await saveRestore(key, { id, target, chat, size: 10, chunks: 1, done: 0 }, configDir)
  return key
}

test('down removes the config file, the records and the directory itself', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig({ ...LOGGED_IN, settings: { chat: 'me' } }, configDir)
  await anUpload(configDir, { id: 'telstore-20260905-7f3a91', file: '/tmp/data.tar' })

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.ok(await gone(configDir), `${configDir} is still there`)
  assert.match(out.text(), /Done\. Removed /)
})

// Asking a question whose answer changes nothing is the one thing this project avoids
// everywhere else, and there is nothing here to describe either.
test('down on a machine with nothing to remove says so and asks nothing', async () => {
  const parent = await tempDir('down-empty')
  const configDir = path.join(parent, '.telstore')
  const out = collect()

  await runDown([], {}, { configDir, log: out.log, ...NEVER_ASKS })

  assert.match(out.text(), /Nothing to remove/)
  assert.match(out.text(), new RegExp(configDir.replaceAll('.', '\\.')))
  assert.doesNotMatch(out.text(), /Done\./)
})

test('down lists the directory, the session and the unfinished transfers before it asks', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  const asked = []
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  await anUpload(configDir, { id: 'telstore-20260905-7f3a91', file: '/tmp/data.tar' })
  await aRestore(configDir, { id: 'telstore-20260901-9de447', target: '/tmp/photos.zip' })

  await runDown([], {}, {
    configDir,
    log: out.log,
    interactive: () => true,
    confirm: async (question) => {
      asked.push(question)
      // Everything the answer depends on has to be on screen before the question is.
      assert.match(out.text(), /Directory/)
      assert.match(out.text(), /Session/)
      assert.match(out.text(), /1 upload, 1 restore/)
      assert.match(out.text(), /my_backups/)
      return true
    },
  })

  assert.equal(asked.length, 1)
  assert.match(asked[0], /\[y\/N\]/)
})

// An id is the only way left to find chunks already in the chat once its record is gone, so
// the ids are said out loud while there is still someone to read them.
test('down names every unfinished upload before it asks', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)
  await anUpload(configDir, { id: 'telstore-20260905-7f3a91', file: '/tmp/data.tar' })
  await anUpload(configDir, { id: 'telstore-20260907-9de447', file: '/tmp/photos.zip' })

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.match(out.text(), /telstore-20260905-7f3a91/)
  assert.match(out.text(), /telstore-20260907-9de447/)
  assert.match(out.text(), /new backup/)
})

test('down counts unfinished uploads and restores the way status does', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)
  await anUpload(configDir, { id: 'a', file: '/tmp/a.tar' })
  await anUpload(configDir, { id: 'b', file: '/tmp/b.tar' })
  await aRestore(configDir, { id: 'c', target: '/tmp/c.tar' })

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.match(out.text(), /2 uploads, 1 restore/)
})

// A sealed config keeps the api_hash inside the blob, exactly as logout has to say.
test('down names a sealed session as sealed', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig({ sealed: 'tls1.abc', settings: { chat: 'me' } }, configDir)

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.match(out.text(), /sealed/)
  assert.ok(await gone(configDir))
})

test('down on a machine that was never logged in says so and still removes the directory', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig({ settings: { chat: 'me' } }, configDir)

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.match(out.text(), /not logged in/)
  assert.ok(await gone(configDir))
})

test('a no answer removes nothing and says the run was cancelled', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)

  await assert.rejects(
    runDown([], {}, { configDir, log: out.log, interactive: () => true, confirm: async () => false }),
    /Cancelled on request\./,
  )

  assert.equal(await gone(configDir), false)
  await fs.stat(configFile(configDir))
})

// An empty line read as "yes" would wipe the machine of anyone piping into telstore.
test('down without a terminal refuses instead of removing anything', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)

  await assert.rejects(
    runDown([], {}, { configDir, log: out.log, interactive: () => false, confirm: async () => true }),
    /--yes/,
  )

  assert.equal(await gone(configDir), false)
})

test('--yes removes the directory without asking', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)

  await runDown([], { yes: true }, { configDir, log: out.log, ...NEVER_ASKS })

  assert.ok(await gone(configDir))
})

// Under --yes the summary is the only record of what went, so it is printed anyway.
test('--yes still says what it removed', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)
  await anUpload(configDir, { id: 'telstore-20260905-7f3a91', file: '/tmp/data.tar' })

  await runDown([], { yes: true }, { configDir, log: out.log, ...NEVER_ASKS })

  assert.match(out.text(), /Directory/)
  assert.match(out.text(), /telstore-20260905-7f3a91/)
})

// loadConfig's own advice for a corrupt file is "delete the file and log in again". This is
// the command that does it, so it is the one command a corrupt config must not be able to stop.
test('down works on the corrupt config that told the user to delete it', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(configFile(configDir), '{ not json')

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.ok(await gone(configDir))
  assert.match(out.text(), /cannot be read/)
  // loadConfig names the config file in every message it throws, and every path to that file
  // contains a dot. Quoting the first sentence of one cuts the path in half and presents the
  // stump as a diagnosis, so no part of the message is quoted at all.
  assert.doesNotMatch(out.text(), /Corrupt config file/)
  assert.doesNotMatch(out.text(), /Fix the syntax/)
})

test('down names the files telstore did not write before removing them', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)
  await fs.writeFile(path.join(configDir, 'notes.txt'), 'mine')

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.match(out.text(), /notes\.txt/)
  assert.ok(await gone(configDir))
})

// The .partial is the user's data and it still resumes afterwards: down destroyed nothing on
// Telegram, so the manifest a resume checks against is still there.
test('down leaves a .partial alone and says how to finish it', async () => {
  const configDir = await tempDir('down')
  const home = await tempDir('down-target')
  const target = path.join(home, 'big.iso')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)
  await fs.writeFile(`${target}.partial`, 'half')
  await aRestore(configDir, { id: 'telstore-20260905-7f3a91', target, chat: '@my_backups' })

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.equal(await gone(`${target}.partial`), false)
  assert.match(out.text(), new RegExp(`${target.replaceAll('.', '\\.')}\\.partial`))
  assert.match(out.text(), /npx telstore restore telstore-20260905-7f3a91 --out /)
  assert.match(out.text(), /still resumes/)
  // What delete says about a partial it stranded. Here the chunks are untouched, so saying it
  // would send somebody to delete gigabytes they could still have used.
  assert.doesNotMatch(out.text(), /Nothing can finish it now/)
})

test('down does not mention a .partial that is not on disk', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)
  await aRestore(configDir, { id: 'telstore-20260905-7f3a91', target: '/tmp/nowhere-at-all.iso' })

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.doesNotMatch(out.text(), /\.partial/)
})

test('down says the backups are untouched and the session still needs terminating', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.match(out.text(), /Settings → Devices/)
  assert.match(out.text(), /my_backups/)
  assert.match(out.text(), /api_id and api_hash are gone/)
})

// `telstore down telstore-20260905-7f3a91` is the plausible typo, and wiping the machine in
// answer to it would be indefensible.
test('down refuses an extra argument instead of removing everything', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)

  await assert.rejects(
    runDown(['telstore-20260905-7f3a91'], {}, { configDir, log: out.log, ...NEVER_ASKS }),
    /npx telstore delete/,
  )

  assert.equal(await gone(configDir), false)
})

// A recursive remove is the one mistake in this command that cannot be apologised for.
test('down refuses to remove a home directory or a filesystem root', async () => {
  const out = collect()

  await assert.rejects(
    runDown([], { yes: true }, { configDir: os.homedir(), log: out.log, ...NEVER_ASKS }),
    /refuses/,
  )
  await assert.rejects(
    runDown([], { yes: true }, { configDir: path.parse(process.cwd()).root, log: out.log, ...NEVER_ASKS }),
    /refuses/,
  )
})

test('down removes a state directory full of records', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)
  await anUpload(configDir, { id: 'a', file: '/tmp/a.tar' })
  await aRestore(configDir, { id: 'b', target: '/tmp/b.tar' })

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.ok(await gone(stateDir(configDir)))
  assert.ok(await gone(configDir))
})

// --- what a stream upload leaves in the directory ------------------------------------

// `down` names every entry telstore did not write, so that a recursive remove takes nothing
// unannounced. ~/.telstore/tmp is telstore's own — it is where a stream upload borrows one
// chunk of disk at a time — so listing it under "Also there" would be down reporting its own
// working directory as a stranger's file. tempDirFor is imported rather than the name being
// retyped: a copy here would go on passing after the real one moved, which it since has —
// state.js owns the name now, because `status` has to ask where that directory is without
// importing the upload command.
test('the temporary directory a stream upload borrows is not a foreign entry', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)
  await fs.mkdir(tempDirFor(configDir), { recursive: true })

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.doesNotMatch(out.text(), /Also there/)
  assert.ok(await gone(configDir))
})

// A stream record has no path to print, and the ids are listed here precisely so nothing
// goes unnamed — a row reading "undefined" is the failure this listing exists to prevent.
test('down names a stream record by what produced it, not by a path it never had', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)
  await aStream(configDir, { id: 'telstore-20260909-c0ffee', name: 'db.sql' })

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.match(out.text(), /telstore-20260909-c0ffee/)
  assert.match(out.text(), /db\.sql/)
  assert.doesNotMatch(out.text(), /undefined/)
})

// The paragraph above the list says these records are what lets a second run carry on. That
// is true of a file and false of a command's output: those bytes have gone past, and the
// next run cuts them differently. Saying so is the difference between somebody re-running
// the command and somebody expecting a resume that cannot happen.
test('down does not offer to carry on what a command wrote', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)
  await aStream(configDir, { id: 'telstore-20260909-c0ffee', name: 'db.sql' })

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.match(out.text(), /cannot be carried on/)
})

// down.md's own precedent: the resume command for a .partial is printed "because this is the
// last time anything will mention that file". A stream record is the sharper case. It cannot
// be re-run onto — those bytes have gone past — so after down there is no list of those chunks
// on this machine and no manifest naming them in the chat: they are findable by nothing. The
// command that removes them is the last thing anything will ever say about them.
test('down prints the command that removes the chunks a stream record is the only list of', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)
  await aStream(configDir, { id: 'telstore-20260909-c0ffee', name: 'db.sql', chat: '@store' })

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.match(out.text(), /npx telstore delete telstore-20260909-c0ffee --chat @store$/m)
})

// `delete` resolves its own destination from config, so a command printed without --chat would
// fire these ids at whatever chat is configured when it is pasted. The chat goes through
// shellArg for the same reason every other printed command does: it has to survive the shell.
test('the chat a stream record names is quoted so the command can be pasted', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)
  await aStream(configDir, { id: 'telstore-1', name: 'db.sql', chat: 'my chat' })

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.match(out.text(), /npx telstore delete telstore-1 --chat 'my chat'$/m)
})

test('a stream record that cannot say which chat gets no command telstore could not honour', async () => {
  const configDir = await tempDir('down')
  const out = collect()
  await saveConfig(LOGGED_IN, configDir)
  await aStream(configDir, { id: 'telstore-1', name: 'db.sql', chat: '' })

  await runDown([], {}, { configDir, log: out.log, ...YES })

  assert.doesNotMatch(out.text(), /npx telstore delete/)
  assert.match(out.text(), /telstore-1\n\s+this record does not say which chat/)
})
