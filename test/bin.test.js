import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { tempDir } from './helpers.js'

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
