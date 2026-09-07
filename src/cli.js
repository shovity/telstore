import { basename } from 'node:path'
import { parseArgs } from 'node:util'

const SUBCOMMANDS = new Set([
  'login',
  'logout',
  'list',
  'restore',
  'delete',
  'status',
  'config',
  'token',
  'help',
])

const OPTIONS = {
  chat: { type: 'string' },
  'chunk-size': { type: 'string' },
  'upload-concurrency': { type: 'string' },
  'download-concurrency': { type: 'string' },
  out: { type: 'string' },
  note: { type: 'string' },
  limit: { type: 'string' },
  verbose: { type: 'boolean' },
  unset: { type: 'boolean' },
  yes: { type: 'boolean' },
  token: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

export const HELP = `telstore — split large files into chunks and store them on Telegram

Usage:
  npx telstore login                      Log in to Telegram, only needed once
  npx telstore <file|folder|pattern>...   Split files and upload them to Telegram
  npx telstore list                       List the backups stored in the destination
  npx telstore restore <backup-id>...     Download the chunks and reassemble the files
  npx telstore delete <backup-id>...      Remove backups' chunks and manifests from the chat
  npx telstore status                     Show the account, the destination and unfinished backups
  npx telstore config                     Show every setting and where its value comes from
  npx telstore logout                     Remove the saved session

Running on a machine you do not trust:
  npx telstore token                      Print a session token for another machine
  npx telstore login --token              Log in there by pasting one, session stays sealed

Several files in one run go one after another over a single connection, each becoming its own
backup. A folder means the files one level inside it, and a pattern means the names it matches
— the shell usually expands those itself, so quote one to hand it to telstore intact. More than
one file is listed and confirmed before the first byte goes out. Run telstore again with only
the files that are left to carry on after an interruption.

restore and delete take several ids the same way: one connection, one line each, and an exit
code that reports any that failed. delete shows everything it is about to destroy and asks once.

Settings:
  npx telstore config <name>              Print one setting's value
  npx telstore config <name> <value>      Change it for good
  npx telstore config <name> --unset      Drop it and fall back to the default

  chat                 Where backups go: @username, -100123..., or me. No default.
  chunkSize            Size of each chunk, default 1800MB. Examples: 1.8GB, 500MB.
  uploadConcurrency    512KB parts sent in parallel, default 32, max 64.
  downloadConcurrency  8MB slices fetched in parallel, default 8, max 64.
  limit                How many backups list shows, default 20.
  verbose              Show Telegram connection logs, default false.

Options apply to one run and are never saved. Use config to change a setting for good.
  --chat <chat>               Destination for this run only.
  --chunk-size <n>            Chunk size for this run only. An unfinished backup keeps the
                              size it started with.
  --upload-concurrency <n>    512KB parts in parallel while uploading, this run only.
  --download-concurrency <n>  8MB slices in parallel while restoring, this run only.
  --out <path>                Where to write the restored file. Defaults to the basename in
                              the manifest, and works with one backup id only.
  --note <text>               A note to store with the upload. It goes into the manifest and
                              onto the manifest message, where Telegram's own search can find
                              it, and every file of a batch gets the same one. A note with
                              spaces in it has to be quoted — --note "march archive" — or the
                              shell hands the words after the first to telstore as more files
                              to upload.
  --limit <n>                 How many backups list shows this run.
  --token                     Log in by pasting a session token. It takes no value on
                              purpose: a token written on the command line would sit in
                              "ps" for the whole life of the command, and stay in that
                              machine's shell history afterwards.
  --yes                       Upload a batch, or delete, without being asked to confirm.
  --verbose                   Show Telegram connection logs for this run.
  -h, --help                  Show this help.
`

// What Ctrl-C means depends on the command that was running: upload has written every
// finished chunk to a state file, restore has not. Naming the backup matters because the
// id is what `status` lists and what a later `restore` needs — the chunks are already in
// the chat under that id, whether or not this run ever finishes.
export function interruptMessage(command, { backupId, done = [] } = {}) {
  if (command === 'upload') {
    const backup = backupId ? `Backup ${backupId} is saved` : 'Progress is saved'

    // A batch is where "run the same command again" turns into a lie: the files it already
    // finished have had their records cleared, so repeating the whole line would upload them
    // a second time under new ids. Name them, and ask for the ones that are left instead.
    if (done.length > 0) {
      const width = Math.max(...done.map((file) => basename(file.path).length))
      const finished = done
        .map((file) => `  ${basename(file.path).padEnd(width)}  ${file.id}`)
        .join('\n')

      return (
        `\n${backup}. These are finished and need no second run:\n${finished}\n` +
        'Run telstore again with only the files that are left — repeating the whole command ' +
        'would upload the finished ones again as new backups. "npx telstore status" shows ' +
        'what is unfinished.\n'
      )
    }

    return (
      `\n${backup} — run the same command again to continue, ` +
      'or "npx telstore status" to see what is left.\n'
    )
  }

  // A restore keeps its .partial now, and the next run proves each chunk in it against the
  // manifest before trusting a byte — so "running again starts over", which this said while
  // there was nothing to resume from, would now be false.
  if (command === 'restore') {
    // Finished ids have been renamed to their real names and their records removed, so
    // repeating the whole command line would meet an overwrite prompt and then download
    // them again from nothing. Name them and ask for the rest, exactly as a batch upload does.
    if (done.length > 0) {
      const width = Math.max(...done.map((item) => basename(item.path).length))
      const finished = done
        .map((item) => `  ${basename(item.path).padEnd(width)}  ${item.id}`)
        .join('\n')

      return (
        `\nStopped. These are finished and need no second run:\n${finished}\n` +
        'Run telstore again with only the ids that are left — their .partial files are kept, ' +
        'so those carry on where they stopped. "npx telstore status" shows what is unfinished.\n'
      )
    }

    // With onBackupId firing only once the .partial is open, an id here means there is a
    // file to carry on from. Without one, this run stopped before it wrote anything, and
    // saying a .partial was kept would be the same lie this message was rewritten to stop
    // telling — just from the other side.
    if (!backupId) {
      return '\nStopped before anything was written. Run the same command again to start.\n'
    }

    return (
      `\nBackup ${backupId} kept its .partial file — run the same command again from this ` +
      'directory to carry on, or "npx telstore status" to see what is left.\n'
    )
  }

  // A delete has already destroyed messages for good by the time Ctrl-C lands, and the
  // manifest is deliberately still there — it is what a second run reads to finish. Saying
  // only "Stopped." would read as "nothing happened", which is the one thing it never means.
  if (command === 'delete') {
    return (
      '\nStopped. Some chunk messages are already gone — run the same command again to ' +
      'finish removing the backup.\n'
    )
  }

  return '\nStopped.\n'
}

// A channel id is negative, and typing it separated by a space is the natural reflex — but
// parseArgs rejects anything starting with a dash as an option, and reports it as one:
// `config chat -100123` fails with "Unknown option '-1'", naming a flag nobody typed.
//
// Two shapes need rescuing, and they are rescued differently. As a flag value, `--chat -100123`
// is joined into `--chat=-100123`; only a bare negative integer qualifies, so `--chat --verbose`
// still reports the missing value instead of eating the next flag. As a positional —
// `config chat -100123` — there is nothing to join it to, so `--` goes in front and the rest
// of the line is handed over verbatim. That is greedy on purpose: a flag written after the
// id becomes a positional too, and runConfig refuses the extra argument by name, which beats
// an error about `-1`.
//
// Everything after an explicit `--` is left alone, because it is no longer an option there.
function protectNegativeChatIds(argv) {
  const safe = []

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--') {
      safe.push(...argv.slice(i))
      return safe
    }

    if (argv[i] === '--chat' && /^-\d+$/.test(argv[i + 1] ?? '')) {
      safe.push(`--chat=${argv[i + 1]}`)
      i += 1
      continue
    }

    if (/^-\d+$/.test(argv[i])) {
      safe.push('--', ...argv.slice(i))
      return safe
    }

    safe.push(argv[i])
  }

  return safe
}

// An unquoted note is gone by the time node starts: the shell hands `--note ghi chu` over as
// three arguments and nothing can put the quotes back. The one trace it leaves is its own
// tail — every word after the first sits here as a positional, after the flag — and upload
// needs that to tell the mistake from a plain missing file. The shape of the command line is
// already this file's business, so the observation is made here rather than guessed at later.
//
// The last --note is the one parseArgs kept, so it is the one whose position counts.
function filesNamedAfterNote(tokens) {
  const note = tokens.findLast((token) => token.kind === 'option' && token.name === 'note')

  if (!note) return false

  return tokens.some((token) => token.kind === 'positional' && token.index > note.index)
}

export function route(argv) {
  const { values, positionals, tokens } = parseArgs({
    args: protectNegativeChatIds(argv),
    options: OPTIONS,
    allowPositionals: true,
    tokens: true,
  })

  const [first, ...rest] = positionals
  const filesAfterNote = filesNamedAfterNote(tokens)

  // `telstore --chat @chan` with no file used to mean "remember this destination". Flags no
  // longer write anything, so that line now asks for a run that has nothing to upload —
  // say where the destination actually lives instead of printing help at someone who was
  // perfectly clear about what they wanted.
  if (first === undefined && values.chat && !values.help) {
    throw new Error(
      `Nothing to upload. To change the destination for good, run "npx telstore config chat ${values.chat}". ` +
        'To use it for one run, pass --chat alongside a file or a command.',
    )
  }

  if (values.help || first === undefined || first === 'help') {
    return { command: 'help', args: [], options: values, filesAfterNote }
  }

  if (SUBCOMMANDS.has(first)) {
    return { command: first, args: rest, options: values, filesAfterNote }
  }

  // Every positional, not just the first: `telstore a b c` used to upload `a` and drop the
  // rest without a word, which is the one thing this project never does.
  return { command: 'upload', args: positionals, options: values, filesAfterNote }
}
