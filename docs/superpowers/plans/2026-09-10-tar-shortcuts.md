# tar shortcuts and restore into a command — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npx telstore tarc a.tar.gz ./dir` stores a gzipped tar of `./dir`, and
`npx telstore tarx <id>` extracts it again — built on `telstore restore <id> -- <command>`,
which this plan makes real for the first time.

**Architecture:** The two shortcuts are argv rewriting in `route`: they expand into the
`--` form that already exists and return the same shape it returns, so there is exactly one
upload path and exactly one restore-into-a-command path. That second path is new:
`src/commands/restore-stream.js` downloads each chunk into one temp file, verifies its
sha256 against the manifest, and only then writes it into the command's stdin.

**Tech Stack:** Node 18+, pure ESM, `node:test`, one runtime dependency (`teleproto`).

**Spec:** `docs/superpowers/specs/2026-09-10-tar-shortcuts-design.md`, which stands on
`docs/superpowers/specs/2026-09-09-piped-streams-design.md` — read both. The earlier spec's
"Restore into a command: the data path" section is the authority for the data path; the later
one pins down what it left open.

## Global Constraints

- **English only.** Code, comments, user-facing strings, test names, docs, commit messages.
- Node 18+, pure ESM, no TypeScript, no transpilation, no build step.
- Exactly one runtime dependency: `teleproto`. Do not add another.
- Tests use the built-in `node:test` runner only. `npm test` is the whole gate.
- Style: no semicolons, single quotes, two-space indent.
- **Never produce wrong data silently.** A restore that cannot reproduce the original bytes
  must fail rather than hand over a plausible-looking result. These checks are not to be
  relaxed to make a test pass.
- Commands take collaborators through a `deps` object so tests pass fakes. Keep that seam.
- `CLAUDE.md` has a table of "before you change X, read Y". Read the row before the change,
  not after. For this plan that means at minimum `docs/design/data-integrity.md` (any task
  touching `restore-stream.js`, `stream.js` or a printed command),
  `docs/design/module-boundaries.md` (new modules, `bin/telstore.js`),
  `docs/design/settings-and-flags.md` (`src/cli.js`, any flag) and
  `docs/design/terminal-prompts.md` (progress, Ctrl-C).
- Every test must fail if the behaviour it names is removed. A test that passes against
  deleted code is a defect in this plan's output, not a formality.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/tar.js` | What `tarc` and `tarx` know about names: `archiveName`, `isGzipName`. Two pure string functions, no imports — the one place the gzip naming rule lives, read by both the parser and the restore command |
| `src/commands/restore-stream.js` | `runRestoreStream(backupId, childArgv, options, deps)`: the Telegram-to-stdin direction |
| `test/tar.test.js` | The name rule, exhaustively |
| `test/restore-stream.test.js` | The new command against fakes |

**Modified:**

| File | Change |
| --- | --- |
| `src/cli.js` | `tarc`/`tarx` in `SUBCOMMANDS`, their expansions, the rules for a general `restore -- <cmd>` line, the `restore`-into-a-command branch of `interruptMessage`, and the help text |
| `src/stream.js` | `writeChunkTo` (a verified chunk file into a command's stdin) and `discardChunkFile`, moved out of `upload-stream.js` so both directions share one copy |
| `src/commands/upload-stream.js` | Imports `discardChunkFile` instead of holding its own `discard` |
| `src/commands/restore.js` | Exports `realGetMessage` and a `createOnRetry(warn)` extracted from its inline `onRetry`, both of which `restore-stream.js` needs and neither of which may be duplicated |
| `bin/telstore.js` | Dispatch `restore … -- <cmd>` to the new command instead of refusing it; `killChild`; the streaming-restore Ctrl-C |
| `README.md` | The two shortcuts, and `tar cf -` |
| `test/bin.test.js` | Two tests assert the refusal that this plan removes |
| `test/upload-stream.test.js` | One fixture uses the broken `tar cf ./a` |
| `docs/design/*.md`, `CLAUDE.md`, `.claude/skills/e2e/SKILL.md` | Task 9 |

---

### Task 1: The name rule

`tarc` always compresses, so a name that does not say so would describe bytes it does not
hold. This is the whole of that decision, in two pure functions.

**Files:**
- Create: `src/tar.js`
- Test: `test/tar.test.js`

**Interfaces:**
- Produces: `archiveName(name) -> string`, `isGzipName(name) -> boolean`. Task 2 uses the
  first, Task 6 the second.

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { archiveName, isGzipName } from '../src/tar.js'

test('a name that already claims gzip is left exactly as it is', () => {
  assert.equal(archiveName('a.tar.gz'), 'a.tar.gz')
  assert.equal(archiveName('a.tgz'), 'a.tgz')
  assert.equal(archiveName('./backups/march.tar.gz'), './backups/march.tar.gz')
})

// Upper case is a name someone typed, not a different intention. A.TAR.tar.gz would be
// telstore being clever at the expense of the person reading `list` later.
test('the suffix check ignores case, and what it appends is lower case', () => {
  assert.equal(archiveName('A.TGZ'), 'A.TGZ')
  assert.equal(archiveName('A.TAR'), 'A.TAR.gz')
})

test('a plain tar name gains only the .gz it was missing', () => {
  assert.equal(archiveName('a.tar'), 'a.tar.gz')
})

test('anything else gains the whole suffix', () => {
  assert.equal(archiveName('a'), 'a.tar.gz')
  assert.equal(archiveName('march'), 'march.tar.gz')
  // .zip is not tar's business and telstore does not argue with the name it was given
  // beyond making it honest about the gzip.
  assert.equal(archiveName('a.zip'), 'a.zip.tar.gz')
})

test('isGzipName answers for the same spellings archiveName accepts', () => {
  assert.ok(isGzipName('a.tar.gz'))
  assert.ok(isGzipName('a.tgz'))
  assert.ok(isGzipName('A.TAR.GZ'))
  assert.ok(!isGzipName('a.tar'))
  assert.ok(!isGzipName('a'))
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/tar.test.js`
Expected: FAIL — `Cannot find module '../src/tar.js'`.

- [ ] **Step 3: Write `src/tar.js`**

```js
// What the tar shortcuts know about names, and all they know. Pure strings: the parser needs
// it before anything is open and the restore command needs it before anything is downloaded,
// so it belongs to neither of them.
//
// `tarc` always compresses. A backup called a.tar holding gzip bytes would be a name that
// lies to whoever restores it, and the name is what `list` shows and `--search` matches, so
// it is the one part of this that cannot be left to the person typing.
const GZIP_SUFFIXES = ['.tar.gz', '.tgz']

export function isGzipName(name) {
  const lower = String(name).toLowerCase()

  return GZIP_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

// Appended in lower case, matched without case: A.TAR becomes A.TAR.gz rather than
// A.TAR.tar.gz, because the capitals are how someone typed it and not a second intention.
export function archiveName(name) {
  if (isGzipName(name)) return name
  if (String(name).toLowerCase().endsWith('.tar')) return `${name}.gz`

  return `${name}.tar.gz`
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/tar.test.js`
Expected: PASS.

- [ ] **Step 5: Prove the tests are not vacuous**

Delete the `.tar` branch of `archiveName` and re-run: the "plain tar name" test must fail.
Delete the `isGzipName` early return and re-run: the first test must fail. Restore both.
A mutation that survives means the test is decoration and has to be rewritten.

- [ ] **Step 6: Commit**

```bash
git add src/tar.js test/tar.test.js
git commit -m "feat: the gzip naming rule the tar shortcuts share"
```

---

### Task 2: `tarc` expands into the line that already works

**Files:**
- Modify: `src/cli.js` (`SUBCOMMANDS`, a new `tarcLine`, the terminator block, `route`)
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: `archiveName` from Task 1.
- Produces: `route` returns, for a `tarc` line,
  `{ command: 'upload', args: [storedName], options, filesAfterNote, childArgv, shortcut: 'tarc' }`.
  `shortcut` is `'tarc' | 'tarx' | null` and Task 7 reads it.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/cli.test.js`
Expected: FAIL — `tarc` is an ordinary positional today, so the first test reports
`command: 'upload'` with `args: ['tarc', 'a.tar.gz', './x', './y']` and no `childArgv`.

- [ ] **Step 3: Add `shortcut` to every return of `route`**

Every existing `return` in `route` gains `shortcut: null`. There are six, including both
`help` returns and the final upload return. A field that is present on some shapes and absent
on others is a field the next reader has to check twice.

- [ ] **Step 4: Reserve the word and write the expansion**

In `src/cli.js`, add `'tarc'` to `SUBCOMMANDS` (alphabetical position does not matter; the set
is read, not printed), import `archiveName`, and add above `route`:

```js
import { archiveName } from './tar.js'

// tarc is the long form with the three decisions that never change already made: `c` for
// create, `z` for gzip, `f -` for "write it to stdout, which is where telstore is listening".
// The missing `-` is not a hypothetical mistake — it was in this project's own help text and
// README, where `tar cf ./a` exits 2 with "Cowardly refusing to create an empty archive".
//
// An expansion rather than a command of its own: `runStreamUpload` is reached with exactly the
// argv the `--` form reaches it with, so there is no second upload path, no second rollback
// and no second guarantee. It also prints that argv, so the shortcut teaches the long form
// instead of hiding it.
function tarcLine(rest, values, filesAfterNote) {
  const [name, ...paths] = rest

  if (name === undefined) {
    throw new Error(
      'Missing a name for the backup. tarc stores the archive under a name you choose. ' +
        'Example: npx telstore tarc a.tar.gz ./a',
    )
  }

  // Refused rather than answered with a guess: a rule that read one positional as a name and
  // two as a name plus a path would make `telstore tarc ./x ./y` archive ./y under the name
  // ./x, which is the silent wrong answer this project exists to refuse.
  if (paths.length === 0) {
    throw new Error(
      `Nothing to archive: tarc needs the paths to put in ${name}. ` +
        'Example: npx telstore tarc a.tar.gz ./a',
    )
  }

  return {
    command: 'upload',
    args: [archiveName(name)],
    options: values,
    filesAfterNote,
    childArgv: ['tar', values.verbose ? 'czvf' : 'czf', '-', ...paths],
    shortcut: 'tarc',
  }
}
```

- [ ] **Step 5: Refuse a shortcut that is followed by its own terminator**

Inside `route`'s `if (childArgv !== null)` block, **before** the existing
`SUBCOMMANDS.has(first)` branch:

```js
    // Reached before the generic "takes no command after --" below, because for these two the
    // reason is different and so is the way out: they are not a subcommand that happens not to
    // run commands, they are a command already.
    if (first === 'tarc' || first === 'tarx') {
      throw new Error(
        `${first} already is the command it runs, so it cannot be followed by another one. ` +
          `Drop the -- to use ${first}, or drop ${first} to write the command out yourself.`,
      )
    }
```

- [ ] **Step 6: Dispatch it**

In `route`, immediately before the `if (SUBCOMMANDS.has(first))` dispatch near the end:

```js
  if (first === 'tarc') return tarcLine(rest, values, filesAfterNote)
```

- [ ] **Step 7: Run the suite**

Run: `node --test test/cli.test.js test/bin.test.js`
Expected: PASS. `npm test` must also pass — `shortcut` is additive, but run it to find any
test that asserted `route`'s whole return shape.

- [ ] **Step 8: Prove the tests are not vacuous**

Remove `['tarc', tarcLine]` from `SHORTCUTS` and re-run: the expansion test must fail (the word
falls through to the upload path). Replace `czvf` with `czf` in the verbose branch: the verbose
test must fail. Restore both.

- [ ] **Step 9: Commit**

```bash
git add src/cli.js test/cli.test.js
git commit -m "feat: telstore tarc expands into the -- form"
```

---

### Task 3: `tarx`, and the rules for a general `restore -- <command>`

`route` has let `restore <id> -- <cmd>` through since the stream work, with `bin` refusing it.
This task settles what shapes of that line are legal, because Task 7 makes it run.

**Files:**
- Modify: `src/cli.js`
- Test: `test/cli.test.js`

**Interfaces:**
- Produces: for a `tarx` line,
  `{ command: 'restore', args: [id], options, filesAfterNote, childArgv, shortcut: 'tarx' }`.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/cli.test.js`
Expected: FAIL — `tarx` is a positional, and the `restore` branch accepts any number of ids
with any flags.

- [ ] **Step 3: Write the expansion**

Add `'tarx'` to `SUBCOMMANDS`, and beside `tarcLine`:

```js
// The mirror of tarcLine. `x` for extract, `z` because tarc always compressed, `f -` because
// the bytes arrive on stdin.
function tarxLine(rest, values, filesAfterNote) {
  requireOneBackupId(rest, 'tarx')

  const childArgv = ['tar', values.verbose ? 'xzvf' : 'xzf', '-']

  // Pushed after `-` on purpose, which is the order measured to work on GNU tar 1.35:
  // `tar xzf - -C ./here`. See the probe table in the spec.
  if (values.out !== undefined) childArgv.push('-C', values.out)

  return { command: 'restore', args: rest, options: values, filesAfterNote, childArgv, shortcut: 'tarx' }
}

// One command reads one stream, so a line that names two backups is a line with no answer:
// extracting two archives into one working directory in sequence is a question nobody asked.
function requireOneBackupId(ids, what) {
  if (ids.length === 0) {
    throw new Error(`Missing backup id. Example: npx telstore ${what} telstore-20260905-7f3a91`)
  }

  if (ids.length > 1) {
    throw new Error(
      `One command reads one stream, so ${what} takes one backup id and got ${ids.length}: ` +
        `${ids.join(', ')}. Run telstore once per backup.`,
    )
  }
}
```

- [ ] **Step 4: Tighten the general `restore -- <cmd>` branch**

In `route`'s terminator block, the existing `restore` pass-through becomes:

```js
      if (first === 'restore') {
        requireOneBackupId(rest, 'restore')

        // --out places a file, and this path writes none: the bytes go to the command on its
        // stdin. Left to pass silently it would read as "restore into the command AND write
        // the file over there", which is not what happens.
        if (values.out !== undefined) {
          throw new Error(
            'A restore into a command writes no file, so --out has nothing to place: the bytes ' +
              'go to the command on its stdin. Tell the command where to put them instead ' +
              '(npx telstore restore <id> -- tar xf - -C ./here).',
          )
        }

        return { command: first, args: rest, options: values, filesAfterNote, childArgv, shortcut: null }
      }
```

And the generic refusal beside it loses the clause that is about to stop being true:

```js
        throw new Error(
          `${first} takes no command after --. An upload (npx telstore a.tar -- tar cf - ./a) ` +
            'and a restore (npx telstore restore <id> -- tar xf -) are the two that run one.',
        )
```

- [ ] **Step 5: Dispatch it**

Beside the `tarc` line added in Task 2:

```js
  if (first === 'tarx') return tarxLine(rest, values, filesAfterNote)
```

- [ ] **Step 6: Run the suite**

Run: `node --test test/cli.test.js test/bin.test.js`
Expected: PASS. `tarx` now reaches `bin`, which still refuses it — that refusal goes in
Task 7, and the bin test asserting it must still pass until then.

- [ ] **Step 7: Prove the tests are not vacuous**

Delete the `-C` push: the `--out` test must fail. Delete the `ids.length > 1` branch of
`requireOneBackupId`: two id tests must fail. Restore both.

- [ ] **Step 8: Commit**

```bash
git add src/cli.js test/cli.test.js
git commit -m "feat: telstore tarx, and the shape a restore into a command may take"
```

---

### Task 4: A verified chunk file into a command's stdin

One helper, and one move so the two directions share a single copy of the temp-file cleanup.

**Files:**
- Modify: `src/stream.js` (add `writeChunkTo`, add `discardChunkFile`)
- Modify: `src/commands/upload-stream.js` (delete its private `discard`, import instead)
- Test: `test/stream.test.js`

**Interfaces:**
- Produces:
  - `writeChunkTo(writable, handle, length, { onProgress }) -> Promise<void>`
  - `discardChunkFile(handle, file, { writeErr, chunkSize }) -> Promise<void>`

**Read first:** `docs/design/data-integrity.md` and `docs/design/module-boundaries.md`.

- [ ] **Step 1: Write the failing tests**

```js
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'

import { writeChunkTo } from '../src/stream.js'

async function chunkFile(bytes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telstore-stream-'))
  const file = path.join(dir, 'chunk')

  await fs.writeFile(file, bytes)

  return { handle: await fs.open(file, 'r'), dir }
}

test('it writes exactly the length it was given, and no more', async () => {
  const { handle, dir } = await chunkFile(Buffer.from('abcdefghij'))
  const sink = new PassThrough()
  const seen = []

  sink.on('data', (bytes) => seen.push(bytes))

  // 4, not 10: the file may be longer than the chunk it holds when a download was cut short,
  // and the manifest's length is the one that decides.
  await writeChunkTo(sink, handle, 4)
  await handle.close()
  await fs.rm(dir, { recursive: true, force: true })

  assert.equal(Buffer.concat(seen).toString(), 'abcd')
})

// Two chunks down one pipe is the whole point: the command sees one stream, not one per chunk.
test('the destination stays open between chunks and the handle survives', async () => {
  const { handle, dir } = await chunkFile(Buffer.from('abcde'))
  const sink = new PassThrough()
  const seen = []

  sink.on('data', (bytes) => seen.push(bytes))

  await writeChunkTo(sink, handle, 5)
  await writeChunkTo(sink, handle, 5)

  assert.equal(sink.writableEnded, false)

  // Still ours: the read stream must not have closed the fd underneath us.
  const probe = Buffer.alloc(1)
  assert.equal((await handle.read(probe, 0, 1, 0)).bytesRead, 1)

  await handle.close()
  await fs.rm(dir, { recursive: true, force: true })
  assert.equal(Buffer.concat(seen).toString(), 'abcdeabcde')
})

test('progress is reported as the bytes go, not in one lump at the end', async () => {
  const { handle, dir } = await chunkFile(Buffer.alloc(200_000, 1))
  const sink = new PassThrough({ highWaterMark: 1024 })

  sink.resume()

  let reported = 0
  let calls = 0

  await writeChunkTo(sink, handle, 200_000, {
    onProgress: (bytes) => {
      reported += bytes
      calls += 1
    },
  })

  await handle.close()
  await fs.rm(dir, { recursive: true, force: true })

  assert.equal(reported, 200_000)
  assert.ok(calls > 1, `expected several progress calls, got ${calls}`)
})

// A command that stops reading is the failure this function exists to surface. Silence here
// would become a restore reported as finished for a command that never saw it.
test('a destination that fails surfaces the failure', async () => {
  const { handle, dir } = await chunkFile(Buffer.alloc(64_000, 1))
  const sink = new Writable({
    write(_bytes, _encoding, done) {
      done(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    },
  })

  await assert.rejects(() => writeChunkTo(sink, handle, 64_000), /EPIPE/)

  await handle.close()
  await fs.rm(dir, { recursive: true, force: true })
})

test('a zero-length chunk writes nothing and does not throw', async () => {
  const { handle, dir } = await chunkFile(Buffer.alloc(0))
  const sink = new PassThrough()

  await writeChunkTo(sink, handle, 0)
  await handle.close()
  await fs.rm(dir, { recursive: true, force: true })

  assert.equal(sink.readableLength, 0)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/stream.test.js`
Expected: FAIL — `writeChunkTo` is not exported.

- [ ] **Step 3: Write `writeChunkTo`**

Append to `src/stream.js`:

```js
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// The other direction from ChunkReader, and unlike it this one can use the stream library as
// it comes. ChunkReader is hand-rolled because it has to stop at a chunk boundary and keep
// what it did not take; here the whole file is wanted, in order, and `pipeline` already does
// the two things that matter: it honours backpressure, so a chunk is never buffered in this
// process, and it rejects when the destination fails instead of going quiet.
//
// `{ end: false }` is what makes a command see one stream rather than one per chunk. Measured
// on node 22 rather than assumed, along with the fact that a FileHandle read stream opened
// this way leaves the handle open for the next chunk: `autoClose: false`.
export async function writeChunkTo(writable, handle, length, { onProgress = () => {} } = {}) {
  // `end: length - 1` is inclusive, so zero has to be turned away before it asks for byte -1.
  if (length === 0) return

  const counted = new Transform({
    transform(bytes, _encoding, done) {
      onProgress(bytes.length)
      done(null, bytes)
    },
  })

  // Not a 'data' listener on the source: attaching one switches the stream to flowing mode and
  // the backpressure this function exists to honour goes with it.
  const source = handle.createReadStream({ start: 0, end: length - 1, autoClose: false })

  await pipeline(source, counted, writable, { end: false })
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/stream.test.js`
Expected: PASS.

- [ ] **Step 5: Move `discard` where both directions can reach it**

Cut the `discard` function out of `src/commands/upload-stream.js` — comment and all, it is
load-bearing — and paste it into `src/stream.js` as `export async function discardChunkFile`.
It keeps `fs` from `node:fs` and `formatBytes` from `./progress.js`. In `upload-stream.js`,
import `discardChunkFile` and rename the two call sites. Nothing about its behaviour changes.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS, with the same count as before plus the new `stream.test.js` tests.

- [ ] **Step 7: Prove the tests are not vacuous**

Replace `{ end: false }` with `{}` in `writeChunkTo`: the "stays open between chunks" test must
fail. Remove `onProgress(bytes.length)`: the progress test must fail. Restore both.

- [ ] **Step 8: Commit**

```bash
git add src/stream.js src/commands/upload-stream.js test/stream.test.js
git commit -m "feat: write a verified chunk file into a command's stdin"
```

---

### Task 5: What `restore-stream.js` needs from `restore.js`

Two things `restore.js` keeps private that the new command must not copy. Pure extraction:
no behaviour changes, and the suite proves it.

**Files:**
- Modify: `src/commands/restore.js`
- Test: `test/restore.test.js` (only if an existing test names `onRetry` behaviour; otherwise
  the existing suite passing unchanged is the proof)

**Interfaces:**
- Produces: `realGetMessage(client, peer, msgId)` exported, and
  `createOnRetry(warn) -> (err, attempt, delayMs, elapsedMs) => void` exported, built from the
  `onRetry` currently defined inside `runRestore`.

- [ ] **Step 1: Export `realGetMessage`**

Add `export` to the existing `async function realGetMessage`. Nothing else changes.

- [ ] **Step 2: Lift `onRetry` out of `runRestore`**

Move the body verbatim into a module-level factory, keeping every comment — `LONG_WAIT_MS`
and `ANNOUNCE_AFTER_ATTEMPT` stay where they are:

```js
// Lifted out of runRestore so the streaming restore uses this one rather than a second copy
// that drifts. A retry nobody is told about is indistinguishable from a hung transfer, because
// the progress bar simply stops moving while the wait runs.
export function createOnRetry(warn) {
  return function onRetry(err, attempt, delayMs, elapsedMs = 0) {
    // ... the existing body, unchanged, comments included
  }
}
```

Inside `runRestore`, replace the declaration with `const onRetry = createOnRetry(warn)`.

- [ ] **Step 3: Run the suite**

Run: `npm test`
Expected: PASS, same count as before. A refactor that changes a count has changed behaviour.

- [ ] **Step 4: Commit**

```bash
git add src/commands/restore.js
git commit -m "refactor: restore's retry notice and message read move out where both restores reach them"
```

---

### Task 6: `runRestoreStream`

The new command, whole: the happy path and every row of the spec's failure table. One task
because the failures are not an afterthought here — which bytes have reached the command by
the time something goes wrong is the entire substance of the thing.

**Files:**
- Create: `src/commands/restore-stream.js`
- Test: `test/restore-stream.test.js`

**Interfaces:**
- Consumes: `writeChunkTo`, `discardChunkFile` (Task 4); `realGetMessage`, `realDownloadChunk`,
  `createOnRetry` (Task 5); `isGzipName` (Task 1); `spawnProducer` from `src/spawn.js`, whose
  `exited` **resolves** `{ code, signal }` for a non-zero exit and **rejects** only for a
  command that cannot start.
- Produces: `runRestoreStream(backupId, childArgv, options, deps) -> { id, size, chunks }`.
  `deps`: `connect`, `disconnect`, `configDir`, `searchManifest`, `readMessageBytes`,
  `getMessage`, `downloadChunk`, `spawn`, `retryOptions`, `writeErr`, `log`, `silent`,
  `onBackupId`, `onTempChunk`, `onChild`, `requireGzipName`. Task 7 passes the last four.

**Read first:** `docs/design/data-integrity.md`, `docs/design/module-boundaries.md`,
`docs/design/testing-blind-spots.md`, and the earlier spec's "Restore into a command" section.

- [ ] **Step 1: Write the failing tests**

Build on the fakes `test/restore.test.js` already uses for `client`, `searchManifest` and
`readMessageBytes` — read that file first and follow its shape rather than inventing a second
style. A fake child is a `PassThrough` for `stdin` plus a promise for `exited`:

```js
function fakeChild({ exitCode = 0, signal = null, failToStart = null, stopAfter = null } = {}) {
  const stdin = new PassThrough()
  const seen = []
  let killed = false

  stdin.on('data', (bytes) => {
    seen.push(bytes)

    // A command that stops reading: head -c N, or tar falling over. The destination errors,
    // which is what the real pipe does when the far end is gone.
    if (stopAfter !== null && Buffer.concat(seen).length >= stopAfter) {
      stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    }
  })

  return {
    stdin,
    stdout: null,
    exited: failToStart
      ? Promise.reject(new Error(failToStart))
      : new Promise((resolve) => stdin.on('close', () => resolve({ code: exitCode, signal }))),
    kill: () => {
      killed = true
      stdin.destroy()
    },
    bytes: () => Buffer.concat(seen),
    wasKilled: () => killed,
  }
}
```

The tests, each one naming what the command received:

```js
test('every byte the manifest names reaches the command, in order', async () => {
  // Two chunks, the second shorter than the first, so an off-by-one in the length would show.
  // The fake downloadChunk writes the bytes into the handle it is given, exactly as the real
  // one does, and returns their real sha256.
  // Assert: child.bytes() equals the two chunks concatenated, the result reports
  // { chunks: 2, size: <total> }, and the command was not killed.
})

test('nothing is downloaded if the command cannot start', async () => {
  // spawn's exited rejects. Assert: the error names the command, downloadChunk was never
  // called, and no file is left in the temp directory.
})

test('a chunk whose sha256 disagrees with the manifest reaches the command not at all', async () => {
  // Two chunks; the second downloads bytes whose hash does not match.
  // Assert: rejects naming chunk 2, AND child.bytes() is exactly chunk 1 — the whole point is
  // that the bad chunk was never written, not that the error was reported afterwards.
})

test('a chunk whose length disagrees with the manifest is refused the same way', async () => {
  // As above, with size wrong and sha256 right.
})

test('a chunk message that is gone from the chat fails by name', async () => {
  // getMessage returns null for chunk 2. Assert: /no longer in/ and the chunk number.
})

test('a command that stops reading early fails, even though it exited 0', async () => {
  // fakeChild({ stopAfter: 4, exitCode: 0 }) over a manifest of more than 4 bytes.
  // Assert: rejects, the message names how many bytes went in and how many were owed, and
  // the run does NOT report success. This is the test that protects the rule; a restore
  // reported for a command that saw ten bytes of a gigabyte is the silent wrong answer.
})

test('a command that exits non-zero after reading everything fails', async () => {
  // fakeChild({ exitCode: 2 }). Assert: rejects naming exit 2. tar that ran out of disk
  // received every byte and restored nothing.
})

test('a command killed by a signal fails, and says which', async () => {
  // fakeChild({ exitCode: null, signal: 'SIGKILL' }).
})

test('the manifest is checked against itself before anything is downloaded', async () => {
  // manifest.size disagrees with the sum of chunk sizes. Assert: rejects, and downloadChunk
  // was never called. There is no file to stat at the end of this path, so this is the only
  // whole-backup arithmetic there will be.
})

test('the temp chunk file is gone afterwards, on every ending', async () => {
  // Run the happy path and the sha256-mismatch path against a configDir in a temp directory.
  // Assert: tempDirFor(configDir) holds no files in either case. status deliberately never
  // removes one of these, so a run that leaks one leaks it forever.
})

test('onTempChunk names the file while it exists and unsays it afterwards', async () => {
  // Assert: the calls alternate file, null, file, null and end on null.
})

test('tarx refuses a backup whose name does not claim gzip, before downloading anything', async () => {
  // requireGzipName: true, manifest.name 'a.tar'. Assert: rejects naming tar xf -, and
  // searchManifest ran while downloadChunk did not.
})

test('a general restore into a command does not care what the name claims', async () => {
  // requireGzipName defaults false: the same manifest runs through.
})

test('the command it is feeding is printed, and so is the name it is feeding it', async () => {
  // Assert the log holds the backup id, manifest.name, and childArgv joined — the line that
  // makes the shortcut teach the long form.
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/restore-stream.test.js`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the command**

```js
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { describeChat } from '../chat.js'
import {
  closeQuietly,
  connect as realConnect,
  findManifestMessage,
  readMessageBytes as realReadMessageBytes,
} from '../client.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import { parseManifest } from '../manifest.js'
import { createProgress, formatBytes, plural } from '../progress.js'
import { assertLoggedIn } from '../session.js'
import { requireChat, resolveSettings } from '../settings.js'
import { spawnProducer } from '../spawn.js'
import { tempDirFor } from '../state.js'
import { discardChunkFile, writeChunkTo } from '../stream.js'
import { isGzipName } from '../tar.js'
import { createOnRetry, realDownloadChunk, realGetMessage } from './restore.js'

// `telstore restore <id> -- tar xzf -`: the backup's bytes go to a command's stdin instead of
// into a file.
//
// This is runRestore with the file taken away, and the file was carrying more than the bytes:
// no .partial, no resume record, no scan of what an earlier run left, no rename, and no stat
// at the end to compare against the manifest. What replaces all of it is the order of two
// things — verify the chunk, then hand it over — and the command's exit code.
export async function runRestoreStream(backupId, childArgv, options = {}, deps = {}) {
  const {
    connect = realConnect,
    disconnect = (client) => client.destroy(),
    configDir = defaultConfigDir(),
    searchManifest = findManifestMessage,
    readMessageBytes = realReadMessageBytes,
    getMessage = realGetMessage,
    downloadChunk = realDownloadChunk,
    spawn = spawnProducer,
    retryOptions = {},
    writeErr = (line) => process.stderr.write(line),
    log: writeLog = (line) => console.log(line),
    silent = false,
    onBackupId = () => {},
    onTempChunk = () => {},
    // How a Ctrl-C that will not wait still stops the command. Unlike the upload direction
    // there is nothing in the chat to unwind, so this run does not ask to be waited for — but
    // leaving without stopping tar lets it go on writing files after telstore is gone.
    onChild = () => {},
    // tarx only. The alias promises gzip, so it checks the claim before spending a gigabyte
    // finding out; `restore <id> -- tar xf -` promises nothing and is asked nothing.
    requireGzipName = false,
  } = deps

  const config = await loadConfig(configDir)

  assertLoggedIn(config)

  const { values: settings } = resolveSettings(options, config, { file: configFile(configDir) })
  const chat = requireChat(settings)
  const log = silent ? () => {} : writeLog
  const warn = silent ? () => {} : writeErr
  const onRetry = createOnRetry(warn)

  onBackupId(backupId)

  const client = await connect(config, { verbose: settings.verbose })
  let child = null
  let ended = false
  let written = 0

  try {
    const manifestMessage = await searchManifest(client, chat, backupId)

    if (!manifestMessage) {
      throw new Error(
        `No manifest found for ${backupId} in ${chat}. ` +
          'Check the backup id, or use --chat to point at the right chat.',
      )
    }

    const manifest = parseManifest(await readMessageBytes(client, manifestMessage))

    // Before the download, which is the only reason this check is worth making at all: tar
    // would say "not in gzip format" by itself, but only after every byte had arrived.
    if (requireGzipName && !isGzipName(manifest.name)) {
      throw new Error(
        `${backupId} is called ${manifest.name}, which does not claim to be gzipped, and tarx ` +
          `always extracts with "tar xzf -". Run "npx telstore restore ${backupId} -- tar xf -" ` +
          'if it is a plain tar archive. Refused now rather than after the whole backup has ' +
          'been downloaded, which is when tar would find out.',
      )
    }

    const total = manifest.chunks.reduce((sum, chunk) => sum + chunk.size, 0)

    // The whole-backup arithmetic, done here because there will be no file to stat at the end.
    // A manifest that disagrees with itself is one telstore must not start acting on.
    if (total !== manifest.size) {
      throw new Error(
        `The manifest for ${backupId} records ${manifest.size} bytes and its chunks add up to ` +
          `${total}: it disagrees with itself, so telstore will not feed it to a command.`,
      )
    }

    log(`Backup ${backupId}`)
    log(`Name   ${manifest.name} (${plural(manifest.chunks.length, 'chunk')}, ${formatBytes(manifest.size)})`)
    log(`From   ${describeChat(chat)}`)
    log(`Into   ${childArgv.join(' ')}\n`)

    const tmp = tempDirFor(configDir)
    await fs.mkdir(tmp, { recursive: true })

    // Before the first download. A command that cannot start costs nothing here and a whole
    // chunk if it is started later.
    child = spawn(childArgv, { stdio: ['pipe', 'inherit', 'inherit'] })
    onChild(child.kill)

    // Raced against every step below rather than checked between them: a command that dies
    // two minutes into an 1800MB download leaves that download with nowhere to go, and
    // finishing it first would be eight minutes spent on bytes nobody will read. Always
    // throws, so it can never be the value a race resolves with. The no-op catch is for the
    // window before the first race attaches a handler, exactly as `spawnProducer` does it.
    const gone = child.exited.then(
      ({ code, signal }) => {
        throw stoppedReading(childArgv, written, manifest.size, code, signal)
      },
      (err) => {
        throw err
      },
    )
    gone.catch(() => {})

    const progress = createProgress({
      total: manifest.size,
      label: `Chunk 1/${manifest.chunks.length}`,
      write: warn,
    })

    try {
      for (const chunk of manifest.chunks) {
        const file = path.join(tmp, `${backupId}-${chunk.i}.chunk`)

        // Said before the open, for the reason the upload direction says it before its own:
        // the handler has to hold the name for the whole window in which the file can exist.
        onTempChunk(file)

        const handle = await fs.open(file, 'w+')

        try {
          progress.setLabel(`Chunk ${chunk.i + 1}/${manifest.chunks.length}`)

          const message = await Promise.race([getMessage(client, chat, chunk.msgId), gone])

          if (!message) {
            throw new Error(
              `Missing chunk ${chunk.i + 1}/${manifest.chunks.length}: message ${chunk.msgId} ` +
                `is no longer in ${chat}. This backup cannot be restored.`,
            )
          }

          const { sha256, size } = await Promise.race([
            downloadChunk(client, message, handle, 0, progress.advance, {
              retryOptions: { ...retryOptions, onRetry },
              concurrency: settings.downloadConcurrency,
            }),
            gone,
          ])

          if (size !== chunk.size) {
            throw new Error(
              `Chunk ${chunk.i + 1} arrived with ${size} bytes and the manifest records ` +
                `${chunk.size} — mismatch. ${received(childArgv, written)}`,
            )
          }

          if (sha256 !== chunk.sha256) {
            throw new Error(
              `Chunk ${chunk.i + 1} has a sha256 that does not match the manifest. ` +
                `${received(childArgv, written)}`,
            )
          }

          // Only now, and this line is the guarantee: everything above it is what makes the
          // difference between handing a command the backup and handing it whatever arrived.
          await Promise.race([writeChunkTo(child.stdin, handle, size), gone])
          written += size
        } finally {
          await discardChunkFile(handle, file, { writeErr, chunkSize: manifest.chunkSize })

          // Unsaid whether the removal worked or not: if it did there is nothing left to
          // remove, and if it did not, discardChunkFile has already named the file on stderr.
          onTempChunk(null)
        }
      }
    } finally {
      // Ended here rather than after the loop, so a failure mid-chunk still leaves the cursor
      // on a fresh line and "Error: ..." does not land on top of the bar.
      progress.finish()
    }

    // Unreachable if every chunk verified and the manifest agreed with itself, which is why it
    // is worth keeping: it is the one check that does not trust the two above it.
    if (written !== manifest.size) {
      throw new Error(
        `telstore wrote ${written} bytes into ${childArgv[0]} and the manifest records ` +
          `${manifest.size}. Refusing to report a restore it cannot account for.`,
      )
    }

    // The command has had every byte the manifest names; EOF is how it is told so.
    child.stdin.end()

    const { code, signal } = await child.exited
    ended = true

    if (code !== 0 || signal !== null) {
      throw new Error(
        signal !== null
          ? `${childArgv[0]} was killed by ${signal} after receiving all ` +
            `${formatBytes(written)}. telstore is not reporting a restore on its behalf.`
          : `${childArgv[0]} exited ${code} after receiving all ${formatBytes(written)}. ` +
            'telstore is not reporting a restore on its behalf: every byte was correct and ' +
            'the command still did not finish.',
      )
    }

    log(`\nDone. ${formatBytes(written)} went through ${childArgv[0]}, which exited 0.`)

    return { id: backupId, size: written, chunks: manifest.chunks.length }
  } finally {
    // A run that fell over mid-chunk leaves the command alive and blocked on a pipe nothing is
    // going to write to again. Destroying the pipe is what turns that wait into something it
    // can act on; the kill is for a command that is not waiting on stdin at all.
    if (child && !ended) {
      child.stdin.destroy()
      child.kill()
    }

    onChild(null)

    await closeQuietly(client, disconnect, (err) =>
      warn(`\nWarning: could not close the Telegram connection: ${err.message}\n`),
    )
  }
}

// What the command got before this went wrong, in every message about a chunk that did not.
// A person deciding what to do next needs to know the difference between "it has half of my
// archive" and "it has nothing".
function received(childArgv, written) {
  return written === 0
    ? `${childArgv[0]} was given nothing.`
    : `${childArgv[0]} had already been given ${formatBytes(written)}, which was correct but ` +
      'is not the whole backup — whatever it did with that is incomplete.'
}

// A command that is gone while there are bytes left. Exit 0 is included on purpose: `head -c
// 10` exits 0 having read ten bytes of a gigabyte, and reporting that as a restore would be
// the confident wrong answer. Measured, not assumed — see the probe table in the spec.
function stoppedReading(childArgv, written, total, code, signal) {
  const how = signal !== null ? `was killed by ${signal}` : `exited ${code}`

  return new Error(
    `${childArgv[0]} ${how} after reading ${formatBytes(written)} of ${formatBytes(total)}, ` +
      'so it did not receive the backup. Nothing in the chat changed.',
  )
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/restore-stream.test.js`
Expected: PASS.

- [ ] **Step 5: Prove the tests are not vacuous**

Four mutations, each of which must turn the suite red:

1. Move the `writeChunkTo` call above the two mismatch checks → the sha256 test must fail.
2. Delete the `stoppedReading` throw in `gone` (resolve instead) → the early-exit test must
   fail. If it still passes, that test is asserting the wrong thing, and it is the one test
   here that the guarantee rests on.
3. Delete the `total !== manifest.size` check → its test must fail.
4. Delete `onTempChunk(null)` → the alternation test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/commands/restore-stream.js test/restore-stream.test.js
git commit -m "feat: restore a backup onto a command's stdin"
```

---

### Task 7: Wire it into the binary, and into Ctrl-C

**Files:**
- Modify: `bin/telstore.js`
- Modify: `src/cli.js` (`interruptMessage`)
- Test: `test/bin.test.js`, `test/cli.test.js`

**Interfaces:**
- Consumes: `runRestoreStream` (Task 6), `parsed.shortcut` (Tasks 2-3).

**Read first:** `docs/design/terminal-prompts.md` and `docs/design/module-boundaries.md`.

- [ ] **Step 1: Rewrite the two tests that assert the refusal**

`test/bin.test.js` has `restoring into a command is refused, not quietly turned into a file`
and `the help does not offer a restore into a command`. Both assert a decision this task
reverses. Replace the first with the proof it now runs, which at this point in the suite means
getting past the parser and failing on the login instead:

```js
// It used to be refused outright. What tells you it is not any more is where it fails now:
// the login, which is the first thing a restore of any shape needs.
test('restoring into a command reaches the command, not a refusal', async () => {
  const home = await tempDir()
  const { code, stderr } = await runCli(['restore', 'telstore-1', '--', 'tar', 'xf', '-'], { home })

  assert.equal(code, 1)
  assert.match(stderr, /Not logged in/)
  assert.doesNotMatch(stderr, /not built yet/)
  assert.doesNotMatch(stderr, /at .*\.js:\d+/)
})
```

Delete the second outright — Task 8 puts the line in the help that it asserts is absent — and
add, in its place, tests for the shapes the parser turns away before it opens anything:

```js
test('tarc without paths, and tarx with two ids, are turned away with the help', async () => {
  const missing = await runCli(['tarc', 'a.tar.gz'])
  assert.equal(missing.code, 2)
  assert.match(missing.stderr, /Nothing to archive/)

  const two = await runCli(['tarx', 'id-1', 'id-2'])
  assert.equal(two.code, 2)
  assert.match(two.stderr, /one backup id/)
})
```

`runCli` takes no `home` today — extend it with an options argument that passes
`env: { ...process.env, HOME: home }`, following the pattern the `down` tests already use.

- [ ] **Step 2: Add the Ctrl-C message for this direction**

In `src/cli.js`, `interruptMessage`, directly after the `upload && stream` block:

```js
  // The restore direction of the same idea, and the difference is the whole message: a stream
  // upload has to unwind what it put in the chat, while this one put nothing there. What it
  // cannot put back is what the command already did with the bytes it was given.
  if (command === 'restore' && stream) {
    return (
      '\nStopped. Nothing in the chat changed and nothing was kept on this machine, but the ' +
      'command had already been given part of the backup, so whatever it wrote from that is ' +
      'incomplete. A restore into a command cannot be resumed — run it again from the start.\n'
    )
  }
```

With a test in `test/cli.test.js`:

```js
test('Ctrl-C on a restore into a command says what cannot be taken back', () => {
  const message = interruptMessage('restore', { stream: true, backupId: 'telstore-1' })

  assert.match(message, /Nothing in the chat changed/)
  assert.match(message, /incomplete/)
  // The file restore's wording promises a resume. This one must not borrow it.
  assert.doesNotMatch(message, /carry on/)
})
```

- [ ] **Step 3: Stop the command on the way out**

In `bin/telstore.js`, beside `tempChunk`:

```js
// The command a streaming restore is feeding, if one is running. A stream upload unwinds
// cooperatively and kills its own child on the way; a restore has nothing in the chat to
// unwind, so Ctrl-C leaves at once — and leaving without this would let tar go on writing
// files into somebody's directory after telstore had said it stopped. Synchronous, like
// dropTempChunk and for the same reason: anything awaited here would be waiting on the run
// this exit exists to stop waiting for.
let killChild = null

function stopChild() {
  const kill = killChild

  if (kill === null) return

  killChild = null

  try {
    kill()
  } catch {
    // Already gone. There is nothing this could do about it and nothing worth saying.
  }
}
```

and call `stopChild()` as the first statement of `leave()`, before the message is written.

- [ ] **Step 4: Dispatch**

Replace the refusal in `case 'restore'` with:

```js
      // The spec's stage 2, and the refusal that stood here is gone: the bytes were asked for
      // on a command's stdin and that is now where they go.
      if (parsed.childArgv) {
        const { runRestoreStream } = await import('../src/commands/restore-stream.js')

        // So Ctrl-C says the restore sentence rather than the upload one.
        streaming = true

        await runRestoreStream(parsed.args[0], parsed.childArgv, parsed.options, {
          // Only the alias promises gzip. The general form promises nothing and is asked
          // nothing, which is how `restore <id> -- tar xf -` stays useful.
          requireGzipName: parsed.shortcut === 'tarx',
          onBackupId: (id) => {
            currentBackupId = id
          },
          onTempChunk: (file) => {
            tempChunk = file
          },
          onChild: (kill) => {
            killChild = kill
          },
        })
        return
      }
```

No `abortRun`: there is nothing in the chat to unwind, so this run does not ask to be waited
for. `dropTempChunk` in `leave()` removes the buffered chunk and `stopChild` stops the command.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Try it by hand, end to end, with no network**

```bash
node bin/telstore.js tarc            # Missing a name
node bin/telstore.js tarc a.tar.gz   # Nothing to archive
node bin/telstore.js tarx id-1 id-2  # one backup id
HOME=$(mktemp -d) node bin/telstore.js tarx id-1   # Not logged in, no stack trace
```

- [ ] **Step 7: Prove the tests are not vacuous**

Two mutations survive this task on purpose, and the report must name them rather than leave
them looking covered:

- Delete the `requireGzipName` line and nothing goes red. `bin` is not importable as a
  function and the check needs a real manifest, so the wiring is covered by Task 6's unit test
  on both sides of the flag and by Task 10's e2e check 5, not by anything here.
- Delete `stopChild()` from `leave()` and nothing goes red either: a child killed after the
  parent exits is not observable through `execFile`. Check it by hand instead —
  `node bin/telstore.js tarx <id>` against a real backup, Ctrl-C, then `ps` for the `tar` —
  and say in the report whether you did.

- [ ] **Step 8: Commit**

```bash
git add bin/telstore.js src/cli.js test/bin.test.js test/cli.test.js
git commit -m "feat: telstore restore <id> -- <command> runs, and Ctrl-C says what it means"
```

---

### Task 8: The help text, the README, and the broken example

**Files:**
- Modify: `src/cli.js` (`HELP`)
- Modify: `README.md`
- Modify: `bin/telstore.js` (one comment), `docs/design/data-integrity.md` (one line)
- Modify: `test/upload-stream.test.js` (one fixture)
- Test: `test/bin.test.js`

- [ ] **Step 1: Fix `tar cf ./a` everywhere it appears**

`tar cf ./a` becomes `tar cf - ./a` in: `README.md:19`, `README.md:133`, `src/cli.js:63` (the
help prose), `src/cli.js:329` and `src/cli.js:355` (two error messages — line numbers will have
moved by now, so grep), `bin/telstore.js:251` (a comment),
`docs/design/data-integrity.md:45`, and both dated documents of 2026-09-09. In
`test/upload-stream.test.js` the fixture `['tar', 'cf', './a']` and the assertion
`/tar cf \.\/a/` become `['tar', 'cf', '-', './a']` and `/tar cf - \.\/a/`.

```bash
grep -rn "tar cf \./a" . --include="*.js" --include="*.md" | grep -v node_modules
```

must come back empty when this step is done.

- [ ] **Step 2: Add the two shortcuts to the usage block**

```
  npx telstore tarc <name> <path>...      Archive paths with tar and store the archive
  npx telstore tarx <backup-id>           Restore a backup and extract it with tar
  npx telstore restore <id> -- <cmd>...   Restore onto a command instead of a file
```

and the prose that says what they are, which is where the rules live that a usage line cannot
hold — drafted here, to be tightened in place rather than padded:

```
tarc and tarx are the common case written out once. "npx telstore tarc a.tar.gz ./dir" is
"npx telstore a.tar.gz -- tar czf - ./dir", which telstore prints as it runs so the long form
is always in front of you, and tarx is the same for "-- tar xzf -". tarc always compresses, so
it makes the name say so: a.tar becomes a.tar.gz and a name with no tar in it at all gets
.tar.gz. --verbose adds tar's own file listing to both, alongside the Telegram connection log
it already turns on. For tarx, --out is the directory to extract into. Anything beyond
"archive these paths" — -C, --exclude, a pipeline, another compressor — is what -- is for, and
it has not gone anywhere.
```

- [ ] **Step 3: Update the README the same way**

The shortcuts belong in the example block near the top, where `--` already is. Keep the
section short: the help text is the reference, and two places that both explain the name rule
are two places that will disagree about it.

- [ ] **Step 4: Add the bin tests for the help**

```js
test('--help offers the tar shortcuts and the restore into a command', async () => {
  const { code, stdout } = await runCli(['--help'])

  assert.equal(code, 0)
  assert.match(stdout, /telstore tarc/)
  assert.match(stdout, /telstore tarx/)
  assert.match(stdout, /restore <id> -- <cmd>/)
})

// The line the whole plan started from. A help text whose example exits 2 is worse than no
// example: it is a failure the reader blames on telstore.
test('no example in the help writes a tar archive to a file called a', async () => {
  const { stdout } = await runCli(['--help'])

  assert.doesNotMatch(stdout, /tar cf \.\/a/)
  assert.match(stdout, /tar cf - \.\/a/)
})
```

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Read the help back as a user would**

```bash
node bin/telstore.js --help | less
```

Check the usage block still reads as a list someone scans, and that the tarc paragraph is not
longer than the `--` paragraph it sits beside.

- [ ] **Step 7: Commit**

```bash
git add src/cli.js README.md bin/telstore.js docs/design/data-integrity.md docs/superpowers test/
git commit -m "docs: the tar shortcuts, and an example that runs"
```

---

### Task 9: The reasoning, written where the next session will look

`CLAUDE.md` points at a design doc per area and says to read it before changing what it names.
A feature that does not write itself into those files is a feature the next session undoes by
accident.

**Files:**
- Modify: `CLAUDE.md`, `docs/design/data-integrity.md`, `docs/design/module-boundaries.md`,
  `docs/design/settings-and-flags.md`, `docs/design/terminal-prompts.md`,
  `docs/design/testing-blind-spots.md`, `.claude/skills/e2e/SKILL.md`

- [ ] **Step 1: `CLAUDE.md`**

Two rows: `src/commands/restore-stream.js` and the restore rollback-free path →
`docs/design/data-integrity.md`; `src/tar.js` joins the `src/cli.js` row →
`docs/design/settings-and-flags.md`.

- [ ] **Step 2: `docs/design/data-integrity.md`**

The guarantee, in the words this plan has been arguing from: no byte reaches the command
before the chunk it belongs to has matched its sha256; the run reports a restore only if every
chunk verified, `manifest.size` bytes went through, stdin closed and the command exited 0; a
command that stops reading early is a failure at exit 0; the manifest's own arithmetic is
checked up front because there is no file to stat; and the temp chunk belongs to the run,
removed on every ending, because `status` deliberately never removes one.

- [ ] **Step 3: `docs/design/module-boundaries.md`**

Why `restore.js` was not given a second mode (its whole shape is offsets into a file and a
rename, and a pipe has neither), why `writeChunkTo` may use `pipeline` where `ChunkReader`
could not (nothing here stops at a chunk boundary), and why `src/tar.js` is two string
functions with no imports rather than a branch inside the parser.

- [ ] **Step 4: `docs/design/settings-and-flags.md`**

`--verbose` now reaches a child's argv. `--out` means a directory for `tarx` and is refused
for a general restore into a command.

- [ ] **Step 5: `docs/design/terminal-prompts.md`**

tar's listing is allowed only into a mode that is already noisy by request, because the
progress bar and teleproto's log already share stderr. And Ctrl-C on a streaming restore: an
immediate exit, because there is nothing in the chat to unwind — the opposite of the upload
direction, which has to be waited for.

- [ ] **Step 6: `docs/design/testing-blind-spots.md`**

The restore direction has the same hole the upload direction had: the fake client accepts any
object, so handing teleproto the wrong one is invisible until a real account sees it.

- [ ] **Step 7: `.claude/skills/e2e/SKILL.md`**

Add the gzip-mtime trap as a standing rule — compare the extracted tree, never the archive
bytes, because gzip writes an mtime into its header — and the `tarc` → `tarx` round trip as a
check that belongs in every run from now on.

- [ ] **Step 8: Commit**

```bash
git add CLAUDE.md docs/design .claude/skills/e2e/SKILL.md
git commit -m "docs: why the restore direction is shaped the way it is"
```

---

### Task 10: Against a real account

**Files:** none in `src/`. Findings go into `docs/design/`.

- [ ] **Step 1: Run the `e2e` skill**

`.claude/skills/e2e/SKILL.md` carries the rules that are not optional: ask which chat and
never the real backup chat; isolate `HOME` before running a single command, because `logout`,
`config` and `down` write and `down` removes the whole directory; drive `bin/telstore.js` as a
subprocess; clean up only the ids this run created and print by hand what could not be removed.

- [ ] **Step 2: The checks this feature adds to that run**

1. A `tarc` → `tarx` round trip over a directory tree, `--chunk-size` set so one backup has a
   chunk above the 10MB large-file threshold **and** a remainder below it.
2. Compare the **extracted tree**: every file's sha256, the sorted list of paths, the modes.
   Never the archive bytes — gzip writes an mtime into its header, so two runs over an
   unchanged tree produce different bytes and an archive comparison fails for a reason that has
   nothing to do with telstore.
3. `tarc` over a path that does not exist must leave the chat empty. The rollback is not new;
   running it through an alias is.
4. `restore <id> -- false` must exit non-zero and say the command failed, with no claim of a
   restore.
5. `tarx` on a backup whose name does not claim gzip must be refused before anything is
   downloaded.

- [ ] **Step 3: Report what was not covered**

A run that skipped something and does not say so is worse than no run. `FLOOD_WAIT` on a
rollback is still expected to be uncovered — it has never met a real server — and saying so is
part of the report.

---

## Self-review

**Spec coverage.** CLI surface → Tasks 1-3, 8. The expansion table → Task 2 (`tarc`), Task 3
(`tarx`). The name rule → Task 1. The printed expanded command → Task 2's `From` line, which
`runStreamUpload` already logs, and Task 6's `Into` line. `v` under `--verbose` → Tasks 2-3.
Refusals → Tasks 2-3. The reserved-word cost → Task 2's `./tarc` test. Stage 2's data path,
the four things the earlier spec left open, and the failure table → Task 6. Temp-chunk
ownership → Tasks 4 and 6. Ctrl-C → Task 7. The broken example → Task 8. Testing obligations →
each task's own tests, plus Task 10. Docs to update → Task 9. Open risks → carried into
Task 10's report.

**One spec line that this plan deliberately satisfies differently:** the spec says the expanded
command is printed on its own line before the run. `runStreamUpload` already prints
`From   <argv>` and `Name   <stored name>`, and `runRestoreStream` prints `Into   <argv>`, so
no separate mechanism is added. The requirement is met by the lines that were already there.

**Placeholder scan.** No TBDs. Task 6's test bodies are described rather than written out in
full — deliberately, because the fakes they need are `test/restore.test.js`'s and copying that
file into this plan would put a second, drifting copy of it in the repo's history. What each
test must assert is stated in every case, and Step 5 names the mutations that prove it.

**Type consistency.** `archiveName`/`isGzipName` (Task 1) are used in Tasks 2 and 6.
`shortcut` is added to every `route` return in Task 2 and read in Task 7.
`writeChunkTo(writable, handle, length, { onProgress })` and
`discardChunkFile(handle, file, { writeErr, chunkSize })` (Task 4) are called with those
signatures in Task 6. `realGetMessage` and `createOnRetry` (Task 5) are imported in Task 6.
`spawnProducer(argv, { stdio })` returning `{ stdin, stdout, exited, kill }` is the existing
signature, used unchanged.
