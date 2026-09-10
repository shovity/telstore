import test from 'node:test'
import assert from 'node:assert/strict'

import { HELP, OPTIONS, route, interruptMessage } from '../src/cli.js'

test('a first argument that is not a subcommand is treated as a file to upload', () => {
  const r = route(['data.tar'])
  assert.equal(r.command, 'upload')
  assert.deepEqual(r.args, ['data.tar'])
})

test('a path with slashes is still an upload', () => {
  const r = route(['./backups/data.tar'])
  assert.equal(r.command, 'upload')
  assert.deepEqual(r.args, ['./backups/data.tar'])
})

test('every file named after the first is kept, not dropped', () => {
  const r = route(['a.tar', 'b.tar', 'c.tar'])
  assert.equal(r.command, 'upload')
  assert.deepEqual(r.args, ['a.tar', 'b.tar', 'c.tar'])
})

test('flags around several files are still parsed as flags', () => {
  const r = route(['a.tar', '--chat', '@store', 'b.tar'])
  assert.equal(r.command, 'upload')
  assert.deepEqual(r.args, ['a.tar', 'b.tar'])
  assert.equal(r.options.chat, '@store')
})

test('restore is recognised as a subcommand with a backup id', () => {
  const r = route(['restore', 'telstore-20260905-7f3a91'])
  assert.equal(r.command, 'restore')
  assert.deepEqual(r.args, ['telstore-20260905-7f3a91'])
})

test('login and logout are subcommands', () => {
  assert.equal(route(['login']).command, 'login')
  assert.equal(route(['logout']).command, 'logout')
})

test('no arguments shows the help', () => {
  assert.equal(route([]).command, 'help')
})

test('the accompanying flags are parsed', () => {
  const r = route([
    'data.tar',
    '--chat',
    '@my_backups',
    '--chunk-size',
    '1.8GB',
    '--upload-concurrency',
    '4',
    '--download-concurrency',
    '2',
  ])
  assert.equal(r.command, 'upload')
  assert.deepEqual(r.args, ['data.tar'])
  assert.equal(r.options.chat, '@my_backups')
  assert.equal(r.options['chunk-size'], '1.8GB')
  assert.equal(r.options['upload-concurrency'], '4')
  assert.equal(r.options['download-concurrency'], '2')
})

test('the --out flag belongs to restore', () => {
  const r = route(['restore', 'telstore-1', '--out', '/tmp/out.tar'])
  assert.equal(r.command, 'restore')
  assert.equal(r.options.out, '/tmp/out.tar')
})

test('an invalid flag produces a clear error', () => {
  assert.throws(() => route(['data.tar', '--does-not-exist']), /--does-not-exist/)
})

test('--verbose is parsed as a flag', () => {
  assert.equal(route(['big.iso', '--verbose']).options.verbose, true)
  assert.equal(route(['big.iso']).options.verbose, undefined)
  assert.equal(route(['restore', 'telstore-1', '--verbose']).options.verbose, true)
})

test('a negative channel id is accepted separated by a space, not only with =', () => {
  assert.equal(route(['data.tar', '--chat', '-1001234567890']).options.chat, '-1001234567890')
  assert.equal(route(['data.tar', '--chat=-1001234567890']).options.chat, '-1001234567890')
  assert.equal(route(['restore', 'telstore-1', '--chat', '-100123']).options.chat, '-100123')
})

test('joining a negative value does not swallow the flag that follows --chat', () => {
  assert.throws(() => route(['data.tar', '--chat', '--verbose']), { code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' })
})

test('a --chat after -- stays a positional', () => {
  assert.equal(route(['data.tar', '--', '--chat', '-100123']).options.chat, undefined)
})

test('status is a subcommand', () => {
  const r = route(['status'])
  assert.equal(r.command, 'status')
  assert.deepEqual(r.args, [])
  assert.equal(route(['status', '--verbose']).options.verbose, true)
})

test('--chat without a file points at the command that actually saves a destination', () => {
  assert.throws(() => route(['--chat', '@my_backups']), /telstore config chat @my_backups/)
  assert.throws(() => route(['--chat', '-1001234567890']), /telstore config chat -1001234567890/)
})

test('--chat with --help is still help, not an error', () => {
  assert.equal(route(['--chat', '@my_backups', '--help']).command, 'help')
})

test('config is a subcommand and carries its key and value as arguments', () => {
  assert.equal(route(['config']).command, 'config')
  assert.deepEqual(route(['config']).args, [])
  assert.deepEqual(route(['config', 'chat']).args, ['chat'])
  assert.deepEqual(route(['config', 'chat', '@my_backups']).args, ['chat', '@my_backups'])
})

test('a negative channel id survives as a config value, where there is no flag to join it to', () => {
  assert.deepEqual(route(['config', 'chat', '-1001234567890']).args, ['chat', '-1001234567890'])
})

test('--unset reaches the config command', () => {
  const r = route(['config', 'chat', '--unset'])
  assert.equal(r.command, 'config')
  assert.deepEqual(r.args, ['chat'])
  assert.equal(r.options.unset, true)
})

test('--chat with a file still uploads', () => {
  assert.equal(route(['data.tar', '--chat', '@my_backups']).command, 'upload')
})

test('no arguments at all is still help', () => {
  assert.equal(route([]).command, 'help')
  assert.equal(route(['--chunk-size', '1GB']).command, 'help')
})

test('list is a subcommand, not a file to upload', () => {
  const parsed = route(['list'])

  assert.equal(parsed.command, 'list')
  assert.deepEqual(parsed.args, [])
})

test('list takes --limit and --chat', () => {
  const parsed = route(['list', '--limit', '5', '--chat', '@store'])

  assert.equal(parsed.command, 'list')
  assert.equal(parsed.options.limit, '5')
  assert.equal(parsed.options.chat, '@store')
})

test('list takes --search', () => {
  const parsed = route(['list', '--search', 'reports.zip'])

  assert.equal(parsed.command, 'list')
  assert.equal(parsed.options.search, 'reports.zip')
})

// A term with spaces in it is one term, the way a note is: unquoted, the shell hands the
// words after the first over as files to upload.
test('--search takes a value rather than swallowing the next flag', () => {
  assert.throws(() => route(['list', '--search', '--verbose']), {
    code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
  })
})

test('interrupting an upload names the backup and how to carry on', () => {
  const message = interruptMessage('upload', { backupId: 'telstore-20260905-7f3a91' })

  assert.match(message, /telstore-20260905-7f3a91/)
  assert.match(message, /run the same command again/)
  assert.match(message, /telstore status/)
})

test('interrupting an upload before it has an id still promises nothing false', () => {
  const message = interruptMessage('upload')

  assert.match(message, /run the same command again/)
  assert.doesNotMatch(message, /undefined/)
})

test('interrupting a batch names the backups already finished', () => {
  const message = interruptMessage('upload', {
    backupId: 'telstore-20260905-7f3a91',
    done: [
      { path: '/backups/a.tar', id: 'telstore-20260905-aaaaaa' },
      { path: '/backups/b.tar', id: 'telstore-20260905-bbbbbb' },
    ],
  })

  assert.match(message, /telstore-20260905-7f3a91/)
  assert.match(message, /a\.tar\s+telstore-20260905-aaaaaa/)
  assert.match(message, /b\.tar\s+telstore-20260905-bbbbbb/)

  // Running the whole command again would upload the finished files a second time, so the
  // line that says to do exactly that must not survive into a batch.
  assert.doesNotMatch(message, /run the same command again/)
  assert.match(message, /files that are left/)
  assert.match(message, /telstore status/)
})

test('a batch that has finished nothing yet reads exactly like a single upload', () => {
  const one = interruptMessage('upload', { backupId: 'telstore-20260905-7f3a91' })
  const batch = interruptMessage('upload', { backupId: 'telstore-20260905-7f3a91', done: [] })

  assert.equal(batch, one)
})

// A backup made from a command cannot be resumed — the bytes have gone past and the next run
// cuts them differently — so the chunks already in the chat are chunks nothing will ever
// point at again. The file wording promises exactly the resume this one cannot have.
test('Ctrl-C during a stream upload does not promise a resume that cannot happen', () => {
  const message = interruptMessage('upload', { backupId: 'telstore-1', stream: true })

  assert.match(message, /cannot be resumed/)
  assert.match(message, /removing/i)
  assert.doesNotMatch(message, /run the same command again/i)
})

test('a second Ctrl-C leaves the id and the way to clean up by hand', () => {
  const message = interruptMessage('upload', {
    backupId: 'telstore-1',
    stream: true,
    again: true,
    chat: '@my backups',
  })

  // The chat is named for the same reason the rollback's own recovery line names it: a later
  // `delete` resolves its own destination from config, and firing these ids at the wrong peer
  // destroys whatever happens to carry them there.
  assert.match(message, /npx telstore delete telstore-1 --chat '@my backups'/)
})

// The one caller of deleteCommand's chatless branch, and until this test nothing anywhere
// exercised it: a Ctrl-C landing before the run ever said where it was sending leaves the id,
// which is the only part of the line worth having, rather than `--chat null` — a flag that
// looks like a destination and would send runDelete to resolve one from config instead.
test('a second Ctrl-C before the run named a chat prints the id and no --chat', () => {
  const message = interruptMessage('upload', {
    backupId: 'telstore-1',
    stream: true,
    again: true,
    chat: null,
  })

  assert.match(message, /npx telstore delete telstore-1"/)
  assert.doesNotMatch(message, /--chat/)
  assert.doesNotMatch(message, /null|undefined/)
})

test('a stream upload interrupted before anything was sent promises nothing false', () => {
  const message = interruptMessage('upload', { stream: true })

  assert.match(message, /Stopped before anything was sent/)
  assert.doesNotMatch(message, /undefined/)
  assert.doesNotMatch(message, /removing/i)
})

// The stream branch is reached by a flag the file call sites never pass, and a file upload's
// chunks are kept on purpose for the next run to resume onto.
test('a file upload keeps its own wording when the stream branch exists', () => {
  const message = interruptMessage('upload', { backupId: 'telstore-1' })

  assert.match(message, /run the same command again/)
  assert.doesNotMatch(message, /cannot be resumed/)
})

test('interrupting a restore before a .partial exists promises no file to resume', () => {
  const message = interruptMessage('restore')

  assert.match(message, /Stopped before anything was written/)
  assert.doesNotMatch(message, /starts over/)
  assert.doesNotMatch(message, /\.partial/)
})

test('Ctrl-C during a restore points at the .partial that was kept', () => {
  const message = interruptMessage('restore', { backupId: 'telstore-20260901-7c1b40' })

  assert.match(message, /telstore-20260901-7c1b40/)
  assert.match(message, /\.partial/)
  assert.doesNotMatch(message, /starts over/)
})

test('Ctrl-C during a batch restore names what is already finished', () => {
  const message = interruptMessage('restore', {
    backupId: 'telstore-b',
    done: [{ id: 'telstore-a', path: '/home/ai/first.tar' }],
  })

  assert.match(message, /first\.tar/)
  assert.match(message, /telstore-a/)
  assert.match(message, /only the ids that are left/)
})

test('Ctrl-C on a restore into a command says what cannot be taken back', () => {
  const message = interruptMessage('restore', { stream: true, backupId: 'telstore-1' })

  assert.match(message, /Nothing in the chat changed/)
  assert.match(message, /incomplete/)
  // The file restore's wording promises a resume. This one must not borrow it.
  assert.doesNotMatch(message, /carry on/)
})

test('interrupting anything else just says it stopped', () => {
  assert.equal(interruptMessage('login'), '\nStopped.\n')
  assert.equal(interruptMessage(null), '\nStopped.\n')
})

test('delete is a subcommand carrying the backup id', () => {
  const r = route(['delete', 'telstore-20260905-7f3a91'])
  assert.equal(r.command, 'delete')
  assert.deepEqual(r.args, ['telstore-20260905-7f3a91'])
})

test('delete without an id is still routed, so the command can say what is missing', () => {
  const r = route(['delete'])
  assert.equal(r.command, 'delete')
  assert.deepEqual(r.args, [])
})

test('--yes is a flag, present only when it was typed', () => {
  assert.equal(route(['delete', 'telstore-1', '--yes']).options.yes, true)
  assert.equal(route(['delete', 'telstore-1']).options.yes, undefined)
})

test('delete reaches a negative channel id like every other command', () => {
  const r = route(['delete', 'telstore-1', '--chat', '-1001234567890'])
  assert.equal(r.command, 'delete')
  assert.deepEqual(r.args, ['telstore-1'])
  assert.equal(r.options.chat, '-1001234567890')
})

test('verify is a subcommand carrying the backup ids', () => {
  const r = route(['verify', 'telstore-1', 'telstore-2'])
  assert.equal(r.command, 'verify')
  assert.deepEqual(r.args, ['telstore-1', 'telstore-2'])
})

test('verify without an id is still routed, so the command can say what is missing', () => {
  const r = route(['verify'])
  assert.equal(r.command, 'verify')
  assert.deepEqual(r.args, [])
})

test('verify reaches a negative channel id like every other command', () => {
  const r = route(['verify', 'telstore-1', '--chat', '-1001234567890'])
  assert.equal(r.command, 'verify')
  assert.equal(r.options.chat, '-1001234567890')
})

// Ctrl-C during a delete has already destroyed messages for good, and the manifest is
// deliberately still there. Saying "Stopped." alone would read as "nothing happened".
test('Ctrl-C during a delete says some chunks are already gone', () => {
  const message = interruptMessage('delete')
  assert.match(message, /already gone/)
  assert.match(message, /again/)
})

test('token routes as a command, not as a file to upload', () => {
  const r = route(['token'])
  assert.equal(r.command, 'token')
  assert.deepEqual(r.args, [])
})

// A flag carrying the token would sit in `ps` for the whole life of the command and stay in
// the shell history of a machine the user does not trust. It takes no value on purpose.
test('--token takes no value', () => {
  const r = route(['login', '--token'])
  assert.equal(r.command, 'login')
  assert.equal(r.options.token, true)
  // A token typed after the flag lands as a positional rather than being eaten by it, which
  // is what lets runLogin refuse it by name instead of ignoring it while it sits in the
  // history of a machine the user does not trust.
  assert.deepEqual(route(['login', '--token', 'tls1.abc']).args, ['tls1.abc'])
})

// A note with spaces in it reaches telstore as one argument only because the shell was told
// to keep it whole. Both spellings do that, and both have to arrive here identically.
test('a quoted note arrives whole whichever way it was written', () => {
  assert.equal(route(['a.tar', '--note', 'quarterly accounts']).options.note, 'quarterly accounts')
  assert.equal(route(['a.tar', '--note=quarterly accounts']).options.note, 'quarterly accounts')
})

// The failure this flag invites: an unquoted note, whose remaining words the shell hands over
// as separate arguments and route can only read as more files to upload. Nothing here can fix
// that — the words are gone by the time node starts — but the shape has to stay predictable
// so the command that gets them can say what happened.
test('an unquoted note leaves its remaining words as positionals', () => {
  const r = route(['a.tar', '--note', 'quarterly', 'accounts'])

  assert.equal(r.options.note, 'quarterly')
  assert.deepEqual(r.args, ['a.tar', 'accounts'])
})

// A file called `down` in the working directory is no longer uploadable as `telstore down`
// — the same trade `list`, `status` and `token` already made — but the argument after it must
// still arrive as an argument, so runDown can refuse it by name rather than wiping the machine.
test('down is a subcommand, not a file to upload', () => {
  assert.equal(route(['down']).command, 'down')
  assert.deepEqual(route(['down']).args, [])
  assert.deepEqual(route(['down', 'telstore-20260905-7f3a91']).args, ['telstore-20260905-7f3a91'])
  assert.equal(route(['down', '--yes']).options.yes, true)
})

// A flag the parser accepts and the help never mentions is a feature only its author knows
// about. This is the one test that notices when the two drift apart — so it reads the parser's
// own table rather than a copy of it. The copy had gone stale and could not say so: it still
// listed `to` long after `--to` was removed, and passed anyway, because `HELP.includes('--to')`
// is satisfied by the `--token` two lines further down. A substring is not a mention, hence the
// word boundary; a hand-kept list is not the parser, hence Object.keys.
test('every flag the parser accepts is named in the help', () => {
  const flags = Object.keys(OPTIONS)

  assert.ok(flags.length > 0)

  for (const flag of flags) {
    assert.match(HELP, new RegExp(`--${flag}\\b`), `--${flag} is missing from the help`)
  }
})

// The other direction, which nothing checked at all: a flag the help promises and the parser
// refuses sends someone to a command that dies with "Unknown option". Only the flags the help
// sets out as its own count — `--chat @elsewhere` inside a sentence is prose, not a promise.
test('every flag the help sets out is one the parser accepts', () => {
  const promised = new Set(
    [...HELP.matchAll(/^ {2}(?:-\w, )?--([a-z-]+)/gm)].map((match) => match[1]),
  )

  assert.ok(promised.size > 0)

  for (const flag of promised) {
    assert.ok(flag in OPTIONS, `--${flag} is in the help and not in the parser`)
  }
})

// `--note ghi chu` and `--note "ghi chu"` look the same by the time node starts, with one
// exception: the unquoted one leaves its own tail sitting after the flag as positionals.
// That position is the only evidence there is, so route is where it gets written down.
test('route notices a file named after --note', () => {
  assert.equal(route(['a.tar', '--note', 'ghi', 'chu']).filesAfterNote, true)
  assert.equal(route(['--note=ghi', 'chu']).filesAfterNote, true)
})

test('route reports no file after a note the shell kept whole', () => {
  assert.equal(route(['a.tar', '--note', 'ghi chu']).filesAfterNote, false)
  assert.equal(route(['not-found', '--note', 'march']).filesAfterNote, false)
  assert.equal(route(['a.tar']).filesAfterNote, false)
})

test('a name before -- is a stream upload, and the rest is the command', () => {
  const r = route(['a.tar', '--', 'tar', 'cf', './a'])
  assert.equal(r.command, 'upload')
  assert.deepEqual(r.args, ['a.tar'])
  assert.deepEqual(r.childArgv, ['tar', 'cf', './a'])
})

test('flags still belong to telstore when they come before the terminator', () => {
  const r = route(['a.tar', '--chat', '@store', '--', 'tar', 'cf', './a'])
  assert.equal(r.options.chat, '@store')
  assert.deepEqual(r.childArgv, ['tar', 'cf', './a'])
})

test("the child's own flags are never read as telstore's", () => {
  const r = route(['a.tar', '--', 'tar', '--verbose', '-C', './a'])
  assert.deepEqual(r.childArgv, ['tar', '--verbose', '-C', './a'])
  assert.equal(r.options.verbose, undefined)
})

test('an ordinary upload has no childArgv', () => {
  assert.equal(route(['data.tar']).childArgv, null)
})

test('a missing name before -- is refused rather than read as the command name', () => {
  assert.throws(() => route(['--', 'tar', 'cf', './a']), /name before --/)
})

test('two names before -- are refused: one command produces one stream', () => {
  assert.throws(() => route(['a.tar', 'b.tar', '--', 'tar', 'c', './x']), /one name/)
})

test('a terminator with nothing after it is refused', () => {
  assert.throws(() => route(['a.tar', '--']), /command after --/)
})

test('a negative chat id is still a chat id, not a command to run', () => {
  const r = route(['config', 'chat', '-100123'])
  assert.equal(r.command, 'config')
  assert.deepEqual(r.args, ['chat', '-100123'])
  assert.equal(r.childArgv, null)
})

test('a subcommand that cannot take a command is refused by name', () => {
  assert.throws(() => route(['verify', 'telstore-1', '--', 'tar', 'x']), /verify/)
})

// --help asks what telstore does; it is never the mistake one of the terminator checks
// above exists to catch, so it has to win no matter where a -- sits on the line.
test('--help wins over every terminator check, in any of its spellings', () => {
  assert.equal(route(['--help', '--', 'tar', 'cf', './a']).command, 'help')
  assert.equal(route(['-h', '--', 'tar', 'cf', './a']).command, 'help')
  assert.equal(route(['--help', '--']).command, 'help')
})

// The `help` subcommand is another spelling of the same request, so a terminator after it
// is read the same way a terminator after --help is: as still asking for help, not as a
// command for `help` to refuse the way `verify` and the rest do.
test('the help subcommand wins over a terminator too', () => {
  assert.equal(route(['help', '--', 'tar', 'cf']).command, 'help')
})

// The test that matters most: the shortcut IS the long form. Anything else it could be —
// a lookalike that drifts the day someone edits one of them — is the bug this asserts away.
test('tarc expands into exactly the -- line a person could have typed', () => {
  const short = route(['tarc', 'a.tar.gz', './x', './y'])
  const long = route(['a.tar.gz', '--', 'tar', 'czf', '-', './x', './y'])

  assert.equal(short.command, long.command)
  assert.deepEqual(short.args, long.args)
  assert.deepEqual(short.childArgv, long.childArgv)
  assert.equal(short.shortcut, 'tarc')
  assert.equal(long.shortcut, null)
})

test('the stored name is run through the gzip naming rule', () => {
  assert.deepEqual(route(['tarc', 'a.tar', './x']).args, ['a.tar.gz'])
  assert.deepEqual(route(['tarc', 'march', './x']).args, ['march.tar.gz'])
})

// tar writes its listing to stderr, where the progress bar lives, so it is only invited into
// a mode that is already noisy by request.
test('--verbose adds v to tar and still sets the flag telstore reads', () => {
  const parsed = route(['tarc', '--verbose', 'a.tar.gz', './x'])

  assert.deepEqual(parsed.childArgv, ['tar', 'czvf', '-', './x'])
  assert.equal(parsed.options.verbose, true)
})

test('flags that belong to telstore still reach telstore', () => {
  const parsed = route(['tarc', '--chat', '@store', '--note', 'march', 'a.tar.gz', './x'])

  assert.equal(parsed.options.chat, '@store')
  assert.equal(parsed.options.note, 'march')
  assert.deepEqual(parsed.childArgv, ['tar', 'czf', '-', './x'])
})

test('tarc with a name and nothing to archive is refused', () => {
  assert.throws(() => route(['tarc', 'a.tar.gz']), /Nothing to archive/)
})

test('tarc with no name at all is refused', () => {
  assert.throws(() => route(['tarc']), /Missing a name/)
})

// Two commands on one line is a line with no answer, so it gets a refusal rather than a
// guess about which one was meant.
test('tarc cannot be followed by -- : it already is the command', () => {
  assert.throws(() => route(['tarc', 'a.tar.gz', './x', '--', 'tar', 'cf', '-', './x']),
    /already is the command/)
})

test('a file literally named tarc still uploads as ./tarc', () => {
  const parsed = route(['./tarc'])

  assert.equal(parsed.command, 'upload')
  assert.deepEqual(parsed.args, ['./tarc'])
})

test('tarx expands into the restore -- line a person could have typed', () => {
  const short = route(['tarx', 'telstore-20260905-7f3a91'])
  const long = route(['restore', 'telstore-20260905-7f3a91', '--', 'tar', 'xzf', '-'])

  assert.equal(short.command, 'restore')
  assert.deepEqual(short.args, long.args)
  assert.deepEqual(short.childArgv, long.childArgv)
  assert.equal(short.shortcut, 'tarx')
})

test('tarx --verbose adds v', () => {
  assert.deepEqual(route(['tarx', '--verbose', 'id-1']).childArgv, ['tar', 'xzvf', '-'])
})

// --out means "where the files go", which for tar is -C. On this path telstore writes no file
// of its own, so there is nothing else for it to mean.
test('tarx --out becomes tar -C', () => {
  assert.deepEqual(route(['tarx', '--out', './here', 'id-1']).childArgv,
    ['tar', 'xzf', '-', '-C', './here'])
})

test('tarx needs an id, and exactly one', () => {
  assert.throws(() => route(['tarx']), /Missing backup id/)
  assert.throws(() => route(['tarx', 'id-1', 'id-2']), /one backup id/)
})

// One command reads one stream, the mirror of the rule the upload direction already keeps.
test('a general restore into a command takes one id too', () => {
  assert.throws(() => route(['restore', '--', 'tar', 'xf', '-']), /Missing backup id/)
  assert.throws(() => route(['restore', 'a', 'b', '--', 'tar', 'xf', '-']), /one backup id/)
})

// A flag that silently does nothing is worse than a flag that is refused.
test('--out is refused for a restore into a command, which writes no file', () => {
  assert.throws(
    () => route(['restore', 'id-1', '--out', './x', '--', 'tar', 'xf', '-']),
    /writes no file/,
  )
})

test('the message for a subcommand that cannot take a command names both that can', () => {
  assert.throws(() => route(['list', '--', 'tar', 'xf', '-']), /npx telstore restore/)
})
