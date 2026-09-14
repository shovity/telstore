import { stderr, stdin } from 'node:process'

import { parseHint, terminalSafe } from './caption.js'
import { openManifest } from './cipher.js'
import { createPrompts, readSecret } from './prompt.js'

export const PASSWORD_ATTEMPTS = 3

// A password that came from an environment variable, a flag or a file came from somewhere that
// kept a copy of it, which is the rule src/token.js keeps for a passphrase. Unattended encrypted
// backups stay on the `--` pipeline with a key-based tool.
const NO_TERMINAL_UPLOAD =
  '--encrypt needs a terminal to type the password in, and there is none here. Run the upload ' +
  'where you can type it; telstore does not read a password from anywhere else.'

// One readline for the whole exchange, as docs/design/terminal-prompts.md requires: two over one
// stdin do not take turns, and the second question would read nothing. On stderr, so a stdout
// someone redirected still carries only what telstore reports.
export async function askNewPassword({ input = stdin, output = stderr } = {}) {
  if (!input.isTTY) throw new Error(NO_TERMINAL_UPLOAD)

  const prompts = createPrompts({ input, output })

  try {
    const password = await prompts.askSecret('Password: ')

    if (password === '') {
      throw new Error('The password is empty. An encrypted backup needs one — run again and type it.')
    }

    const again = await prompts.askSecret('Password again: ')

    if (again !== password) {
      throw new Error(
        'The two passwords are different, so telstore does not know which one you meant. ' +
          'Nothing was sent — run again.',
      )
    }

    const hint = parseHint(await prompts.ask('Hint (optional, shown in the chat as plain text): '), password)

    return { password, hint }
  } finally {
    prompts.close()
  }
}

export function askPassword(question) {
  return readSecret(question)
}

// Opens an encrypted manifest or says why it cannot. Passwords this run has already seen work
// are tried first and silently, so a batch of backups under one password asks once. A failed
// tag cannot tell a wrong password from an altered manifest, so the last refusal names both,
// likelier first, as src/token.js does for a token.
export async function unlockManifest(
  manifest,
  { askPassword: ask, interactive = () => Boolean(stdin.isTTY), known = [], say = () => {} },
) {
  for (const password of known) {
    const opened = await openManifest(manifest, password)
    if (opened) return { ...opened, password }
  }

  if (!interactive()) {
    throw new Error(
      `${manifest.id} is encrypted, and there is no terminal here to type its password in. ` +
        'Run this where you can type it; telstore does not read a password from anywhere else.',
    )
  }

  say(`Backup ${manifest.id} is encrypted.`)

  // Printed before any key exists, so the seal that covers it cannot have been checked yet: at
  // this moment it is as trustworthy as the chat it came from, and is made safe to print as such.
  const hint = manifest.enc.hint ? terminalSafe(manifest.enc.hint) : ''

  if (hint) say(`Hint   ${hint}`)

  for (let attempt = 1; attempt <= PASSWORD_ATTEMPTS; attempt += 1) {
    const password = await ask('Password: ')
    const opened = password === '' ? null : await openManifest(manifest, password)

    if (opened) {
      known.push(password)
      return { ...opened, password }
    }

    if (attempt < PASSWORD_ATTEMPTS) say('That password does not open it. Try again.')
  }

  throw new Error(
    `Could not open ${manifest.id} after ${PASSWORD_ATTEMPTS} attempts: either the password is ` +
      'wrong or the manifest was altered. Encryption cannot tell those two apart, so telstore ' +
      'will not guess — check the password first.' +
      (hint
        ? ' The hint shown comes from the chat and is only checked once the password opens the ' +
          'backup, so a hint that does not help may itself have been altered.'
        : ''),
  )
}
