import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'

import { askNewPassword, unlockManifest } from '../src/password.js'

import { PASSWORD, encryptedBackup } from './helpers.js'

// Answers each question only once it has been asked. A line that reaches readline before its
// question exists is dropped, exactly as a real terminal drops it (docs/design/terminal-prompts.md),
// so writing every answer up front would test a fake that behaves better than the real thing.
function scriptedTerminal(answers) {
  const input = new PassThrough()
  input.isTTY = true
  input.setRawMode = () => input

  const queue = [...answers]
  const written = []
  const output = new PassThrough()

  output.write = (chunk) => {
    const text = String(chunk)
    written.push(text)

    if (/(Password: |Password again: |Hint .*: )$/.test(text) && queue.length > 0) {
      const next = queue.shift()
      setImmediate(() => input.write(`${next}\n`))
    }

    return true
  }

  return { input, output, text: () => written.join('') }
}

test('a new password is asked twice and a hint once', async () => {
  const term = scriptedTerminal(['s3cret pass', 's3cret pass', 'the cat'])
  const chosen = await askNewPassword({ input: term.input, output: term.output })

  assert.deepEqual(chosen, { password: 's3cret pass', hint: 'the cat' })
  assert.doesNotMatch(term.text(), /s3cret/)
})

test('an empty hint is no hint', async () => {
  const term = scriptedTerminal(['s3cret pass', 's3cret pass', ''])
  const chosen = await askNewPassword({ input: term.input, output: term.output })
  assert.equal(chosen.hint, null)
})

test('two different passwords are refused', async () => {
  const term = scriptedTerminal(['one', 'two'])
  await assert.rejects(() => askNewPassword({ input: term.input, output: term.output }), /different/)
})

test('an empty password is refused', async () => {
  const term = scriptedTerminal([''])
  await assert.rejects(() => askNewPassword({ input: term.input, output: term.output }), /empty/)
})

test('a hint that gives the password away is refused', async () => {
  const term = scriptedTerminal(['hunter2', 'hunter2', 'it is hunter2'])
  await assert.rejects(() => askNewPassword({ input: term.input, output: term.output }), /contains the password/)
})

test('no terminal means no password, and nothing is written', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const written = []
  const output = new PassThrough()
  output.write = (chunk) => written.push(String(chunk))

  await assert.rejects(() => askNewPassword({ input, output }), /--encrypt needs a terminal/)
  assert.equal(written.join(''), '')
})

async function fixture(hint = 'the cat') {
  return await encryptedBackup({ content: randomBytes(40), chunkSize: 16, hint })
}

test('unlock shows the hint and opens with the right password', async () => {
  const { manifest, plainSha256 } = await fixture()
  const said = []
  const opened = await unlockManifest(manifest, {
    askPassword: async () => PASSWORD,
    interactive: () => true,
    say: (line) => said.push(line),
  })

  assert.deepEqual(opened.plainSha256, plainSha256)
  assert.equal(opened.password, PASSWORD)
  assert.ok(said.includes('Hint   the cat'))
})

test('a wrong password is asked again, and three wrong ones stop', async () => {
  const { manifest } = await fixture()
  let asked = 0

  await assert.rejects(
    () =>
      unlockManifest(manifest, {
        askPassword: async () => {
          asked += 1
          return 'wrong'
        },
        interactive: () => true,
      }),
    /either the password is wrong or the manifest was altered/,
  )
  assert.equal(asked, 3)
})

test('a wrong password then the right one opens it', async () => {
  const { manifest } = await fixture()
  const answers = ['wrong', PASSWORD]

  const opened = await unlockManifest(manifest, {
    askPassword: async () => answers.shift(),
    interactive: () => true,
  })

  assert.equal(opened.password, PASSWORD)
})

test('a password that already opened another backup is tried first, without asking', async () => {
  const { manifest } = await fixture()

  const opened = await unlockManifest(manifest, {
    askPassword: async () => {
      throw new Error('should not have asked')
    },
    interactive: () => false,
    known: ['other', PASSWORD],
  })

  assert.equal(opened.password, PASSWORD)
})

test('a password typed and accepted joins the known ones for the next backup', async () => {
  const { manifest } = await fixture()
  const known = []

  await unlockManifest(manifest, { askPassword: async () => PASSWORD, interactive: () => true, known })

  assert.deepEqual(known, [PASSWORD])
})

test('no terminal is refused by name before anything is asked', async () => {
  const { manifest } = await fixture()

  await assert.rejects(
    () =>
      unlockManifest(manifest, {
        askPassword: async () => {
          throw new Error('should not have asked')
        },
        interactive: () => false,
      }),
    new RegExp(`${manifest.id} is encrypted, and there is no terminal`),
  )
})
