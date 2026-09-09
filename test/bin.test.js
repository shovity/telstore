import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { saveState, streamKey } from '../src/state.js'
import { LOGGED_IN, tempDir } from './helpers.js'

const run = promisify(execFile)
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'telstore.js')

async function runCli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args])
    return { code: 0, stdout, stderr }
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

test('--help prints the help and exits 0', async () => {
  const { code, stdout } = await runCli(['--help'])
  assert.equal(code, 0)
  assert.match(stdout, /npx telstore restore/)
})

test('no arguments prints the help too', async () => {
  const { code, stdout } = await runCli([])
  assert.equal(code, 0)
  assert.match(stdout, /Usage/)
})

test('an unknown flag exits 2 with the help', async () => {
  const { code, stderr } = await runCli(['data.tar', '--made-up'])
  assert.equal(code, 2)
  assert.match(stderr, /--made-up/)
  assert.match(stderr, /Usage/)
})

test('restore without a backup id gives an example, not a stack trace', async () => {
  const { code, stderr } = await runCli(['restore'])
  assert.equal(code, 1)
  assert.match(stderr, /Missing backup id/)
  assert.doesNotMatch(stderr, /at .*\.js:\d+/)
})

// The parser keeps `restore <id> -- <cmd>` whole because it is the spec's stage 2, and for a
// while nothing downstream read it: the run wrote the file to disk and never mentioned the
// command it had been handed. Someone typing this is asking for their data on that command's
// stdin, so a file quietly appearing instead is a different thing done confidently — refusing
// is the only answer that does not need to be discovered afterwards.
test('restoring into a command is refused, not quietly turned into a file', async () => {
  const { code, stdout, stderr } = await runCli(['restore', 'telstore-1', '--', 'tar', 'x'])

  assert.equal(code, 1)
  assert.match(stderr, /not built yet/)
  // The way to do it today, with both halves of it: the restore that works and the command
  // it was going to be piped into.
  assert.match(stderr, /npx telstore restore telstore-1/)
  assert.match(stderr, /tar x/)
  assert.doesNotMatch(stderr, /at .*\.js:\d+/)
  assert.equal(stdout, '')
})

// A refusal the help does not contradict: the usage lines offer what the binary will do.
test('the help does not offer a restore into a command', async () => {
  const { stdout } = await runCli(['--help'])

  assert.doesNotMatch(stdout, /restore <id> --/)
})

test('uploading a nonexistent file gives a short error, not a stack trace', async () => {
  const { code, stderr } = await runCli(['/does/not/exist/at/all.tar'])
  assert.equal(code, 1)
  assert.match(stderr, /Error:/)
  assert.doesNotMatch(stderr, /at .*\.js:\d+/)
})

test('a second file on the command line is uploaded, not dropped', async () => {
  // HOME is isolated so nothing here can reach the real ~/.telstore. The session is a
  // stand-in that only has to get past the login check — the run stops at the missing path,
  // well before anything would open a socket with it.
  const home = await tempDir('upload-many-bin')
  const present = path.join(home, 'present.tar')
  const missing = path.join(home, 'missing.tar')
  await fs.writeFile(present, 'x')
  await fs.mkdir(path.join(home, '.telstore'), { recursive: true })
  await fs.writeFile(
    path.join(home, '.telstore', 'config.json'),
    JSON.stringify({ session: 's', apiId: 1, apiHash: 'h' }),
  )

  const { stdout, stderr } = await run(process.execPath, [BIN, present, missing, '--chat', 'me'], {
    env: { ...process.env, HOME: home },
  }).catch((err) => ({ stdout: err.stdout ?? '', stderr: err.stderr ?? '' }))

  // Before the batch existed, everything after the first path was silently discarded and this
  // run would have complained about the login instead.
  assert.match(stderr, new RegExp(`File does not exist: ${missing}`))
  assert.equal(stdout, '')
})

test('restore refuses --out for several ids before it opens a socket', async () => {
  // The same isolated HOME as above: a stand-in session that only has to get past the login
  // check, since the run stops on the flag well before anything would use it.
  const home = await tempDir('restore-many-bin')
  await fs.mkdir(path.join(home, '.telstore'), { recursive: true })
  await fs.writeFile(
    path.join(home, '.telstore', 'config.json'),
    JSON.stringify({ session: 's', apiId: 1, apiHash: 'h', settings: { chat: 'me' } }),
  )

  const { stdout, stderr } = await run(
    process.execPath,
    [BIN, 'restore', 'telstore-20260905-7f3a91', 'telstore-20260905-9de447', '--out', 'one.tar'],
    { env: { ...process.env, HOME: home } },
  ).catch((err) => ({ stdout: err.stdout ?? '', stderr: err.stderr ?? '' }))

  assert.match(stderr, /--out names one file/)
  assert.doesNotMatch(stderr, /at .*\.js:\d+/)
  assert.equal(stdout, '')
})

test(
  'SIGINT during login: exits 130 without claiming anything false about progress',
  { timeout: 10_000 },
  async () => {
    // HOME points at an isolated temp directory so login never touches the real ~/.telstore.
    const home = await tempDir('sigint')

    const child = spawn(process.execPath, [BIN, 'login'], {
      env: { ...process.env, HOME: home },
    })

    let stdout = ''
    let stderr = ''

    const { code } = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`No api_id prompt appeared in time. stdout so far: ${JSON.stringify(stdout)}`))
      }, 5000)

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
        if (/api_id/.test(stdout)) {
          child.kill('SIGINT')
        }
      })

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })

      child.on('exit', (exitCode) => {
        clearTimeout(timer)
        resolve({ code: exitCode })
      })
    })

    assert.equal(code, 130)
    assert.equal(stderr, '\nStopped.\n')
  },
)

test('list without a login gives a short error, not a stack trace', async () => {
  // HOME points at an isolated temp directory so this never reads the real ~/.telstore.
  const home = await tempDir('list-bin')

  const { stdout, stderr } = await run(process.execPath, [BIN, 'list'], {
    env: { ...process.env, HOME: home },
  }).catch((err) => ({ stdout: err.stdout ?? '', stderr: err.stderr ?? '' }))

  assert.match(stderr, /Not logged in/)
  assert.doesNotMatch(stderr, /at .*\.js:\d+/)
  assert.equal(stdout, '')
})

// config is the one command whose entire job is a file write, and every unit test injects
// configDir. This is the only place the real path, the real argv and the real exit codes
// are exercised together.
test('config writes a setting and reads it back through the real argv', async () => {
  const home = await tempDir('config-bin')

  const env = { ...process.env, HOME: home }

  const set = await run(process.execPath, [BIN, 'config', 'chat', '-1001234567890'], { env })
  assert.match(set.stdout, /chat = -1001234567890/)

  const get = await run(process.execPath, [BIN, 'config', 'chat'], { env })
  assert.equal(get.stdout.trim(), '-1001234567890')

  const list = await run(process.execPath, [BIN, 'config'], { env })
  assert.match(list.stdout, /uploadConcurrency\s+32\s+\(default\)/)

  const stored = JSON.parse(await fs.readFile(path.join(home, '.telstore', 'config.json'), 'utf8'))
  assert.deepEqual(stored, { settings: { chat: -1001234567890 } })
})

test('--chat with nothing to upload names the command that saves a destination', async () => {
  const { code, stderr } = await runCli(['--chat', '@my_backups'])

  assert.equal(code, 2)
  assert.match(stderr, /telstore config chat @my_backups/)
  assert.doesNotMatch(stderr, /at .*\.js:\d+/)
})

test('delete without a backup id explains what is missing', async () => {
  const { code, stderr } = await runCli(['delete'])
  assert.equal(code, 1)
  assert.match(stderr, /Missing backup id/)
  assert.doesNotMatch(stderr, /at .*\.js:\d+/)
})

test('--help mentions delete', async () => {
  const { stdout } = await runCli(['--help'])
  assert.match(stdout, /npx telstore delete/)
})

test('verify without a backup id explains what is missing', async () => {
  const { code, stderr } = await runCli(['verify'])
  assert.equal(code, 1)
  assert.match(stderr, /Missing backup id/)
  assert.doesNotMatch(stderr, /at .*\.js:\d+/)
})

test('--help mentions verify', async () => {
  const { stdout } = await runCli(['--help'])
  assert.match(stdout, /npx telstore verify/)
})

test('--help mentions down', async () => {
  const { stdout } = await runCli(['--help'])
  assert.match(stdout, /npx telstore down/)
})

// Every unit test injects a configDir, which is the one thing production never does: there
// the path comes from os.homedir(). This is the only test that proves down removes the
// directory the binary actually picks — under a HOME of its own, because the alternative is
// deleting the session of whoever runs the suite.
test('down removes the config directory the binary picks for itself', async () => {
  const home = await tempDir('down-home')
  const configDir = path.join(home, '.telstore')

  await fs.mkdir(path.join(configDir, 'state'), { recursive: true })
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ session: 's', apiId: 1, apiHash: 'h', settings: { chat: 'me' } }),
  )

  const { stdout } = await run(process.execPath, [BIN, 'down', '--yes'], {
    env: { ...process.env, HOME: home },
  })

  assert.match(stdout, /Done\. Removed /)
  await assert.rejects(fs.stat(configDir), { code: 'ENOENT' })
})

// A machine that never ran telstore, and a typo that would have wiped one that did.
test('down says there is nothing to remove, and refuses a backup id', async () => {
  const home = await tempDir('down-empty-home')

  const { stdout } = await run(process.execPath, [BIN, 'down'], {
    env: { ...process.env, HOME: home },
  })
  assert.match(stdout, /Nothing to remove/)

  const { code, stderr } = await runCli(['down', 'telstore-20260905-7f3a91'])
  assert.equal(code, 1)
  assert.match(stderr, /npx telstore delete/)
})

// --- a machine that logged in with a session token ---

import { encodeToken } from '../src/token.js'

const SEALED_ACCOUNT = { apiId: 123456, apiHash: '0123456789abcdef', session: '1BQANOTEuMTA4LjU2' }

async function sealedHome() {
  const home = await tempDir('sealed')
  const sealed = await encodeToken(SEALED_ACCOUNT, 'a passphrase')

  await fs.mkdir(path.join(home, '.telstore'), { recursive: true })
  await fs.writeFile(
    path.join(home, '.telstore', 'config.json'),
    JSON.stringify({ sealed, settings: { chat: '@backups' } }),
  )

  return home
}

async function runCliIn(home, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      env: { ...process.env, HOME: home },
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

// The property the whole feature exists for. Not "no file is written" — a state file is fine
// — but "nothing readable is written", checked against the bytes on disk rather than against
// what any one code path meant to do.
test('the session a token carried is nowhere in the config file it produced', async () => {
  const home = await sealedHome()
  const written = await fs.readFile(path.join(home, '.telstore', 'config.json'), 'utf8')

  assert.doesNotMatch(written, /1BQANOTEuMTA4LjU2/)
  assert.doesNotMatch(written, /0123456789abcdef/)
})

// status is what someone runs *because* something is already wrong, and on this machine the
// account line cannot be read without a passphrase nobody can type into a pipe. Everything
// else in the report still has to come out.
test('status on a sealed session stays readable when there is no terminal to unlock it', async () => {
  const home = await sealedHome()
  const { code, stdout } = await runCliIn(home, ['status'])

  assert.equal(code, 0)
  assert.match(stdout, /Session\s+.*config\.json \(sealed/)
  assert.match(stdout, /Account\s+.*no terminal/)
  assert.match(stdout, /Destination\s+https:\/\/web\.telegram\.org/)
  assert.match(stdout, /Unfinished\s+none/)
})

test('nothing a sealed session prints contains the session it hides', async () => {
  const home = await sealedHome()

  for (const args of [['status'], ['config'], ['config', 'chat']]) {
    const { stdout, stderr } = await runCliIn(home, args)

    assert.doesNotMatch(stdout + stderr, /1BQANOTEuMTA4LjU2/, `leaked by: ${args.join(' ')}`)
    assert.doesNotMatch(stdout + stderr, /0123456789abcdef/, `leaked by: ${args.join(' ')}`)
  }
})

test('a token cannot be typed on the command line, and login says so instead of ignoring it', async () => {
  const home = await sealedHome()
  const { code, stderr } = await runCliIn(home, ['login', '--token', 'tls1.abc'])

  assert.equal(code, 1)
  assert.match(stderr, /shell history/)
  assert.doesNotMatch(stderr, /at Object|at async/)
})

// Loading teleproto costs about 0.3s and 45MB, and the commands that never reach the network
// have no use for either. Nothing in the suite would notice a static import creeping back in
// — the CLI would simply get slower — so this asks the runtime which scripts it actually
// loaded. V8's coverage output names every script that was executed, teleproto's included.
async function teleprotoScriptsLoadedBy(args, env = {}) {
  const dir = await tempDir('cov')

  // A command that exits non-zero has still loaded whatever it loaded, and refusing early
  // is exactly what the token case below does, so the exit code is not what is being read.
  await run(process.execPath, [BIN, ...args], {
    env: { ...process.env, ...env, NODE_V8_COVERAGE: dir },
  }).catch(() => {})

  const files = await fs.readdir(dir)
  let count = 0

  for (const name of files) {
    const text = await fs.readFile(path.join(dir, name), 'utf8')
    count += (text.match(/"url":"[^"]*\/teleproto\//g) ?? []).length
  }

  return count
}

test('the offline commands do not load teleproto at all', async () => {
  assert.equal(await teleprotoScriptsLoadedBy(['--help']), 0)
})

// down is the command most likely to be run on a machine with no network at all, and the one
// whose whole job is a path derived from os.homedir(). One import of status.js — the obvious
// place to borrow a resume line from — would put teleproto back in its path unnoticed.
test('down opens nothing, on a machine with nothing to remove', async () => {
  const home = await tempDir('down-offline')

  assert.equal(await teleprotoScriptsLoadedBy(['down'], { HOME: home }), 0)
})

// An empty home never reaches the listing, so the test above only ever proved the early
// return. A stream record is what makes down build a `delete` command — the one place it
// writes a line about something that lives on Telegram, and therefore the one most likely to
// borrow it from a module that knows how to reach Telegram.
test('down opens nothing when it has chunks in a chat to name', async () => {
  const home = await tempDir('down-offline-stream')
  const configDir = path.join(home, '.telstore')

  await saveState(
    streamKey('telstore-20260909-7f3a91'),
    {
      v: 1,
      kind: 'stream',
      id: 'telstore-20260909-7f3a91',
      chat: '@my_backups',
      name: 'a.tar',
      chunkSize: 1024,
      done: { 0: { msgId: 5, size: 1024, sha256: 'x' } },
    },
    configDir,
  )

  assert.equal(await teleprotoScriptsLoadedBy(['down'], { HOME: home }), 0)
})

test('token refuses a config that is not logged in without loading teleproto', async () => {
  // token never opens a socket: it reads the config, asks for a passphrase and seals what is
  // already on disk. The only thing that used to pull teleproto in was assertLoggedIn living
  // in src/client.js, next to connect.
  const home = await tempDir('home')

  assert.equal(await teleprotoScriptsLoadedBy(['token'], { HOME: home }), 0)
})

// The advice about an unquoted note depends on where the words sat on the command line, which
// only route can see and only the binary passes on. Every other test drives runUpload
// directly and would stay green with that wire cut, so this one runs the real thing.
test('an unquoted note is named as the reason a file is missing', async () => {
  const home = await tempDir('note-split-bin')
  const present = path.join(home, 'present.tar')
  await fs.writeFile(present, 'x')
  await fs.mkdir(path.join(home, '.telstore'), { recursive: true })
  await fs.writeFile(
    path.join(home, '.telstore', 'config.json'),
    JSON.stringify({ session: 's', apiId: 1, apiHash: 'h' }),
  )

  const { stderr } = await run(
    process.execPath,
    [BIN, present, '--chat', 'me', '--note', 'ghi', 'chu'],
    { env: { ...process.env, HOME: home } },
  ).catch((err) => ({ stderr: err.stderr ?? '' }))

  assert.match(stderr, /File does not exist/)
  assert.match(stderr, /--note "ghi"/)
})

// --- Ctrl-C during a stream upload ---

// A stream upload has to reach Telegram before any of this matters, and the suite never does.
// So the binary runs out of a copy of itself with exactly one file replaced. `connect` is the
// single door a session goes through (docs/design/module-boundaries.md), which makes it the
// one seam a test can stand in without faking the run around it: the real bin/telstore.js,
// the real src/cli.js and the real upload-stream.js are what execute here, so the signal, the
// exit code and every line asserted below are theirs.
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const FAKE_CLIENT = (realClient) => `
// Written by test/bin.test.js. Everything the real client does is re-exported; only the two
// calls that would open a socket are replaced, and each says so on stderr so the test can wait
// on what the run has actually done rather than on a sleep of its own.
export * from ${JSON.stringify(realClient)}

let nextId = 1000

export async function connect() {
  // A stdout that cannot drain, kept that way for as long as the run lasts. The settled test
  // below needs the process to be alive after its run has ended, and the only thing that holds
  // it there is exitWhenFlushed waiting on output nobody is reading — that test never reads
  // stdout, so the pipe fills and stays full.
  //
  // Written again every 10ms rather than once, and that is the whole of the fix for a flake.
  // One 200KB write left the window standing on a single outstanding flush, and about one run
  // in ten reached exitWhenFlushed with that flush already finished: node's stdio handles do
  // not hold the loop open, so the process left immediately and the second Ctrl-C landed on
  // nothing. Nothing about it was observable from here — the run had printed everything it was
  // ever going to print. A write every 10ms means there is always one outstanding, the flush
  // can never complete, and the process lives exactly the two seconds exitWhenFlushed's own
  // safety net gives it. The interval is also a handle, so the loop cannot empty either.
  if (process.env.TELSTORE_TEST_STALL_STDOUT === '1') {
    setInterval(() => process.stdout.write('.'.repeat(100_000)), 10)
  }

  return {
    async invoke() {
      return true
    },
    async sendFile() {
      // Said before the send rather than after it, so a test can act while the chunk file is
      // still on disk: that is the window the second Ctrl-C was measured landing in.
      process.stderr.write('\\nSENDING\\n')

      // A chunk that never reaches Telegram is the honest stand-in for one still uploading
      // when the user gives up on it — the run is inside sendChunk, not inside a fill, so
      // the finally that removes the chunk file is not going to run on its own.
      if (process.env.TELSTORE_TEST_HANG_SEND === '1') await new Promise(() => {})

      // Slow on purpose: a signal has to be able to land between two chunks.
      await new Promise((resolve) => setTimeout(resolve, 150))
      nextId += 1
      process.stderr.write('\\nSENT ' + nextId + '\\n')
      return { id: nextId }
    },
    async destroy() {},
  }
}

export async function deleteMessages(client, peer, ids) {
  process.stderr.write('\\nDELETING ' + ids.length + '\\n')
  // A rollback that cannot reach Telegram is what a second Ctrl-C has to be able to walk
  // out of, and a hang is the only honest stand-in for one.
  if (process.env.TELSTORE_TEST_HANG_DELETE === '1') await new Promise(() => {})
  await new Promise((resolve) => setTimeout(resolve, 200))
  process.stderr.write('\\nDELETED ' + ids.length + '\\n')
}
`

async function fakeTelegram() {
  const root = await tempDir('stream-sigint')
  const tree = path.join(root, 'tree')

  await fs.mkdir(tree, { recursive: true })

  // package.json comes too, or node reads the copied .js files as CommonJS.
  for (const entry of ['bin', 'src', 'package.json']) {
    await fs.cp(path.join(REPO, entry), path.join(tree, entry), { recursive: true })
  }

  // Symlinked rather than copied: teleproto is 50MB, and the fake below re-exports the real
  // client for everything it does not replace.
  await fs.symlink(path.join(REPO, 'node_modules'), path.join(tree, 'node_modules'))
  await fs.writeFile(
    path.join(tree, 'src', 'client.js'),
    FAKE_CLIENT(path.join(REPO, 'src', 'client.js')),
  )

  const home = path.join(root, 'home')
  await fs.mkdir(path.join(home, '.telstore'), { recursive: true })
  await fs.writeFile(
    path.join(home, '.telstore', 'config.json'),
    JSON.stringify({ ...LOGGED_IN, settings: { chat: 'me' } }),
  )

  return { bin: path.join(tree, 'bin', 'telstore.js'), home }
}

// Every wait below is for something the run itself printed, so nothing here is timed against
// a sleep: the test acts the moment the binary says it has sent a chunk or started removing
// one, whatever the machine's speed.
function drive(bin, args, { home, env = {}, readStdout = true } = {}) {
  const child = spawn(process.execPath, [bin, ...args], {
    env: { ...process.env, HOME: home, ...env },
  })

  const out = { stdout: '', stderr: '' }
  const waiting = []

  const arrived = () => {
    const text = out.stdout + out.stderr
    for (const waiter of [...waiting]) {
      if (!waiter.pattern.test(text)) continue
      waiting.splice(waiting.indexOf(waiter), 1)
      waiter.done()
    }
  }

  // Left unread on purpose when the test wants a stalled pipe: a stream nobody resumes fills
  // up and stays full, which is the condition the assertion is about.
  if (readStdout) {
    child.stdout.on('data', (chunk) => {
      out.stdout += chunk.toString()
      arrived()
    })
  }

  child.stderr.on('data', (chunk) => {
    out.stderr += chunk.toString()
    arrived()
  })

  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))

  return {
    out,
    exited,
    interrupt: () => child.kill('SIGINT'),
    until(pattern, ms = 15_000) {
      return new Promise((resolve, reject) => {
        if (pattern.test(out.stdout + out.stderr)) return resolve()

        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`never printed ${pattern}. stderr: ${out.stderr}`))
        }, ms)

        waiting.push({
          pattern,
          done: () => {
            clearTimeout(timer)
            resolve()
          },
        })
      })
    },
  }
}

// 250000 bytes against 100KB chunks is two whole chunks and a remainder the producer never
// finishes, so the signal always lands with exactly two chunks in the chat and a third being
// filled — something to remove, and a run that is still going.
const PRODUCER = ['--chunk-size', '100KB', '--', 'sh', '-c', 'head -c 250000 /dev/zero; sleep 5']

// The command telstore is asked to run may be an hour of pg_dump, or something that costs
// real money to start. Nothing about the machine's own state is a reason to start it.
test('a stream upload with no login fails before it runs the command', async () => {
  const home = await tempDir('stream-no-login')
  const ran = path.join(home, 'ran')

  // The marker is a file rather than a word on stdout, because the header telstore prints
  // echoes the command line back and would match whatever the command was going to say.
  const { code, stderr } = await runCliIn(home, [
    'bak',
    '--chat',
    'me',
    '--',
    'sh',
    '-c',
    `: > ${ran}`,
  ])

  assert.equal(code, 1)
  assert.match(stderr, /Not logged in/)
  await assert.rejects(fs.stat(ran), { code: 'ENOENT' })
})

// The property the cooperative handler exists for: process.exit at the signal would leave in
// the chat exactly the chunks a stream backup can never point at again.
test(
  'Ctrl-C during a stream upload removes what it sent before the process leaves',
  { timeout: 60_000 },
  async () => {
    const { bin, home } = await fakeTelegram()
    const run = drive(bin, ['bak', ...PRODUCER], { home })

    await run.until(/SENT \d+[\s\S]*SENT \d+/)
    run.interrupt()

    const code = await run.exited

    assert.match(run.out.stderr, /cannot be resumed/)
    assert.match(run.out.stderr, /DELETED 2/)
    assert.match(run.out.stderr, /Nothing this run sent was left in the chat/)

    // A run that stopped because it was asked to is not a command that failed, and the line
    // that would say so belongs to the failures.
    assert.doesNotMatch(run.out.stderr, /^Error:/m)
    assert.equal(code, 130)
  },
)

test(
  'a second Ctrl-C leaves at once and names what may still be in the chat',
  { timeout: 30_000 },
  async () => {
    const { bin, home } = await fakeTelegram()
    const run = drive(bin, ['bak', ...PRODUCER], {
      home,
      env: { TELSTORE_TEST_HANG_DELETE: '1' },
    })

    await run.until(/SENT \d+[\s\S]*SENT \d+/)
    run.interrupt()
    await run.until(/DELETING 2/)
    run.interrupt()

    const code = await run.exited
    const [, id] = run.out.stdout.match(/Backup (telstore-\S+)/)

    assert.equal(code, 130)
    assert.match(run.out.stderr, new RegExp(`npx telstore delete ${id} --chat me`))
    assert.doesNotMatch(run.out.stderr, /DELETED/)
  },
)

// The disk half of that same ending. Measured in the throwaway e2e channel on 2026-09-09:
// three runs, one second Ctrl-C apiece, 37MB of buffered chunks left under ~/.telstore/tmp
// that the printed `delete` does not touch and `status` did not mention. The chunk file has
// to still be there when the second signal lands, which is why the fake hangs inside the send
// rather than between two chunks: a Ctrl-C during a fill unwinds through the loop's own
// `finally` and takes the file with it, and that path was never the leak.
test(
  'a second Ctrl-C takes the chunk it was buffering with it',
  { timeout: 30_000 },
  async () => {
    const { bin, home } = await fakeTelegram()
    const tmp = path.join(home, '.telstore', 'tmp')
    const run = drive(bin, ['bak', ...PRODUCER], { home, env: { TELSTORE_TEST_HANG_SEND: '1' } })

    await run.until(/SENDING/)

    // The control. Without it the assertion at the end would pass just as happily against a
    // run that never wrote a chunk file at all.
    const buffering = await fs.readdir(tmp)

    assert.equal(buffering.length, 1)
    assert.match(buffering[0], /\.chunk$/)

    run.interrupt()
    await run.until(/press Ctrl-C again/)
    run.interrupt()

    const code = await run.exited

    // The send is still hanging and always will be, so leaving at all is the proof that
    // giving the disk back waited on nothing that could hang.
    assert.equal(code, 130)
    assert.deepEqual(await fs.readdir(tmp), [])
  },
)

// The rule this whole branch is about: when telstore leaves something on somebody's machine
// it says so, even on the way out of a signal it was told not to wait on. Replacing the file
// with a directory of the same name is a removal unlink refuses without touching the fd the
// chunk is still open through — the same trick the discard test uses one layer down.
test(
  'a chunk it could not remove on the way out is named rather than left in silence',
  { timeout: 30_000 },
  async () => {
    const { bin, home } = await fakeTelegram()
    const tmp = path.join(home, '.telstore', 'tmp')
    const run = drive(bin, ['bak', ...PRODUCER], { home, env: { TELSTORE_TEST_HANG_SEND: '1' } })

    await run.until(/SENDING/)

    const [name] = await fs.readdir(tmp)
    await fs.unlink(path.join(tmp, name))
    await fs.mkdir(path.join(tmp, name))

    run.interrupt()
    await run.until(/press Ctrl-C again/)
    run.interrupt()

    const code = await run.exited

    assert.equal(code, 130)
    assert.match(run.out.stderr, new RegExp(`still on this machine: ${path.join(tmp, name)}`))
    assert.match(run.out.stderr, /remove it by hand/)

    // And the line it was said alongside is still there: the chat is the more expensive of
    // the two leftovers, and a warning about a file must not push it out.
    assert.match(run.out.stderr, /Leaving now/)
  },
)

// A file upload's chunks are kept on purpose — the next run resumes onto them — so its Ctrl-C
// is still the immediate exit it always was, with no rollback anywhere near it.
test(
  'Ctrl-C during a file upload still keeps its chunks and leaves at once',
  { timeout: 60_000 },
  async () => {
    const { bin, home } = await fakeTelegram()
    const file = path.join(home, 'big.tar')
    await fs.writeFile(file, Buffer.alloc(600_000, 7))

    const run = drive(bin, [file, '--chunk-size', '100KB'], { home })

    await run.until(/SENT \d+[\s\S]*SENT \d+/)
    run.interrupt()

    const code = await run.exited

    assert.equal(code, 130)
    assert.match(run.out.stderr, /run the same command again to continue/)
    assert.doesNotMatch(run.out.stderr, /DELETING/)
  },
)

// The run is over by the time this Ctrl-C lands — the rollback finished and the arm returned —
// and the process is only holding on for its own output to reach a pipe nobody is reading. Every
// line the handler could otherwise reach for describes a run that is still going: a removal in
// progress, leftovers to delete by hand, a resume for a backup that is finished.
//
// Two things make this a test rather than a coin toss. The settle line is written one statement
// before `settled = true`, and a signal is only handled between turns of the loop, so a process
// that has printed it has already set the flag. And the window it is signalled into is held open
// by the stalled stdout the fake keeps writing into (see connect above), which is what stops the
// process leaving before the second signal arrives.
test(
  'Ctrl-C after the run has settled claims nothing about a run that is over',
  { timeout: 30_000 },
  async () => {
    const { bin, home } = await fakeTelegram()
    const run = drive(bin, ['bak', ...PRODUCER], {
      home,
      env: { TELSTORE_TEST_STALL_STDOUT: '1' },
      readStdout: false,
    })

    await run.until(/SENT \d+[\s\S]*SENT \d+/)
    run.interrupt()

    // The run's own last word, so the second signal is timed against what happened rather
    // than against a clock.
    await run.until(/Nothing this run sent was left in the chat/)
    run.interrupt()

    const code = await run.exited

    assert.equal(code, 130)
    assert.match(run.out.stderr, /\nStopped\.\n$/)
    assert.doesNotMatch(run.out.stderr, /Leaving now/)
    assert.doesNotMatch(run.out.stderr, /may still have chunks/)
  },
)
