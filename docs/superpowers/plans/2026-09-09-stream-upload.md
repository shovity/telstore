# Stream upload implementation plan (stage 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npx telstore a.tar -- tar cf ./a` uploads a backup from a command's stdout, sends
the manifest only if that command exits 0, and deletes everything it sent if anything goes
wrong.

**Architecture:** telstore spawns the command and reads its stdout into a temp file one chunk
at a time, then uploads that temp file through the existing `uploadRange` — so `uploader.js`,
`chunking.js` and the retry/stall machinery are untouched. A stream has no resume, so the
local state record exists only to know which messages to delete when a run fails.

**Tech Stack:** Node 18+, pure ESM, no TypeScript, `node:test` only, one runtime dependency
(`teleproto`). No new dependency is added by this plan.

**Spec:** `docs/superpowers/specs/2026-09-09-piped-streams-design.md`

**Out of scope (stage 2, separate plan):** `restore <id> -- <command>`. Nothing in this plan
depends on it, and nothing in it depends on this plan beyond the `--` parsing in Task 1.

## Global Constraints

- Node 18+, pure ESM, no TypeScript, no transpilation.
- Exactly one runtime dependency: `teleproto`. Do not add another.
- Tests use the built-in `node:test` runner only. `npm test` is the whole gate.
- Style: no semicolons, single quotes, two-space indent.
- **English only**: code, comments, user-facing strings, test names, docs, commit messages.
- **Never produce wrong data silently.** A backup that cannot be restored must fail loudly at
  upload time. No check in this plan may be relaxed to make a test pass.
- Commands take collaborators through a `deps` object so tests pass fakes. Keep that seam.
- Read the `docs/design/` row for any area you touch before you change it (see the table in
  `CLAUDE.md`). For this plan that is: `data-integrity.md`, `batches.md`,
  `settings-and-flags.md`, `module-boundaries.md`, `captions.md`, `testing-blind-spots.md`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/cli.js` (modify) | Recognise a user-typed `--`, split telstore's arguments from the child's, refuse the ambiguous shapes |
| `src/caption.js` (modify) | A stream chunk's caption, which has no total |
| `src/progress.js` (modify) | A progress line for a transfer with no known total |
| `src/stream.js` (create) | `ChunkReader`: fill a file handle with at most N bytes from a Readable, report EOF |
| `src/spawn.js` (create) | The spawn seam: argv in, `{ stdout, exited, kill }` out |
| `src/state.js` (modify) | Stream records: keyed on the backup id, never resumable |
| `src/commands/upload-stream.js` (create) | `runStreamUpload`: the loop, the manifest condition, the rollback |
| `bin/telstore.js` (modify) | Route a stream upload, and make Ctrl-C wait for the rollback |
| `src/commands/status.js` (modify) | Show a stream record as leftover chunks, not as a resumable upload |
| `src/commands/delete.js` (modify) | Describe a record that has no `path` |

`src/commands/upload.js` is already 569 lines and is not the place for a second upload loop.
The new command file imports `statSource`-free helpers only; anything genuinely shared
(`onRetry` wording, `LONG_WAIT_MS`) is exported from `upload.js` rather than copied.

---

### Task 1: `route` splits telstore's arguments from the child's

**Files:**
- Modify: `src/cli.js` (`route`, `HELP`)
- Test: `test/cli.test.js`

**Interfaces:**
- Produces: `route(argv)` returns `{ command, args, options, filesAfterNote, childArgv }`.
  `childArgv` is `null` when the user typed no `--`, otherwise a non-empty array of strings.
  For `command: 'upload'` with a `childArgv`, `args` holds exactly one name.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/cli.test.js`
Expected: FAIL — `childArgv` is undefined, and none of the refusals throw.

- [ ] **Step 3: Implement in `src/cli.js`**

The terminator is read off the **raw** argv, before `protectNegativeChatIds` runs: that
function inserts a `--` of its own to rescue `config chat -100123`, and reading the position
afterwards would turn a negative chat id into a command to execute.

```js
// The one `--` this file did not write. protectNegativeChatIds inserts one to rescue a
// negative chat id from parseArgs, so the position has to be taken off the argv as typed —
// afterwards the two are indistinguishable, and `config chat -100123` would become a
// command telstore tries to run.
function splitAtTerminator(argv) {
  const at = argv.indexOf('--')

  if (at === -1) return { head: argv, childArgv: null }

  return { head: argv.slice(0, at), childArgv: argv.slice(at + 1) }
}
```

In `route`, split first and parse only `head`. Then, when `childArgv` is not null:

```js
if (childArgv !== null && childArgv.length === 0) {
  throw new Error(
    'Nothing to run: -- has to be followed by the command whose output telstore stores. ' +
      'Example: npx telstore a.tar -- tar cf ./a',
  )
}
```

For an upload (`first` is not a subcommand):

```js
if (childArgv) {
  if (positionals.length === 0) {
    throw new Error(
      'Missing a name before --. telstore stores what the command writes under a name you ' +
        'choose, and there is nothing to take one from. Example: npx telstore a.tar -- tar cf ./a',
    )
  }

  if (positionals.length > 1) {
    throw new Error(
      `One command produces one stream, so telstore takes one name before -- and got ` +
        `${positionals.length}: ${positionals.join(', ')}. Run telstore once per backup.`,
    )
  }
}
```

And for a subcommand, only `restore` may carry one (stage 2 implements it; refusing the rest
by name now is what keeps the error honest):

```js
if (childArgv && first !== 'restore') {
  throw new Error(
    `${first} takes no command after --. Only an upload (npx telstore a.tar -- tar cf ./a) ` +
      'and a restore (npx telstore restore <id> -- tar x) read one.',
  )
}
```

Return `childArgv` from every path, `null` where there is none. Add the two example lines to
`HELP` under the usage block.

- [ ] **Step 4: Run the tests**

Run: `node --test test/cli.test.js`
Expected: PASS, and the existing flag-drift test in `test/bin.test.js` still passes.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js test/cli.test.js
git commit -m "feat: -- separates telstore's arguments from a command it runs"
```

---

### Task 2: a caption and a progress line for a transfer with no total

**Files:**
- Modify: `src/caption.js` (`chunkCaption`), `src/progress.js` (add `renderStreamProgress`,
  `createStreamProgress`)
- Test: `test/caption.test.js`, `test/progress.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `chunkCaption({ id, number, total })` where `total` may be `null`;
  `createStreamProgress({ label, write, now, minIntervalMs })` returning
  `{ advance(bytes), setLabel(next), finish() }` — the same three methods `createProgress`
  returns, so the upload loop reads the same either way.

- [ ] **Step 1: Write the failing tests**

```js
// test/caption.test.js
test('a chunk from a stream is captioned without a total nobody knows yet', () => {
  assert.equal(chunkCaption({ id: 'telstore-1', number: 3, total: null }), '📦 telstore-1 · 3')
})

test('a chunk from a file still carries its total', () => {
  assert.equal(chunkCaption({ id: 'telstore-1', number: 3, total: 12 }), '📦 telstore-1 · 3/12')
})
```

```js
// test/progress.test.js
test('a stream line reports what was sent and how fast, and claims no percentage', () => {
  const line = renderStreamProgress({ done: 1024 * 1024, elapsedMs: 1000, label: 'Chunk 2' })
  assert.match(line, /Chunk 2/)
  assert.match(line, /1\.0 MB/)
  assert.match(line, /\/s/)
  assert.doesNotMatch(line, /%/)
  assert.doesNotMatch(line, /ETA/)
})

test('a stream bar pads a shrinking line so no tail of the last one survives', () => {
  const lines = []
  const bar = createStreamProgress({ label: 'Chunk 1', write: (l) => lines.push(l), now: fakeClock() })
  bar.advance(1024 * 1024 * 1024)
  bar.setLabel('Chunk 2')
  bar.finish()
  const widths = lines.map((l) => l.replace(/^\r/, '').replace(/\n$/, '').length)
  assert.ok(widths.every((w) => w === Math.max(...widths)))
})
```

`fakeClock` does not exist yet; write it in the test file as a counter returning
`0, 1000, 2000, ...` on each call, the way `test/progress.test.js` already fakes `now`
(read that file first and follow whatever it does).

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/caption.test.js test/progress.test.js`
Expected: FAIL — `renderStreamProgress` is not exported, and `chunkCaption` writes `3/null`.

- [ ] **Step 3: Implement**

```js
// src/caption.js — a stream knows its chunk number and not its count. "3/?" would be a
// question mark in the chat forever; the number alone is true at the time it is written,
// and the manifest card carries the final count.
export function chunkCaption({ id, number, total }) {
  return total === null || total === undefined
    ? `📦 ${id} · ${number}`
    : `📦 ${id} · ${number}/${total}`
}
```

```js
// src/progress.js — a percentage of an unknown total is an invented number, and an ETA
// from one is worse: it would count down to a finish nobody can predict.
export function renderStreamProgress({ done, elapsedMs, label }) {
  const bytesPerSecond = elapsedMs > 0 ? done / (elapsedMs / 1000) : 0

  return `${label} ${formatBytes(done)} sent ${formatBytes(Math.round(bytesPerSecond))}/s`
}
```

`createStreamProgress` mirrors `createProgress` exactly — same throttle, same `widestLine`
padding, same `\r` discipline — but calls `renderStreamProgress`. Copying that shape is
deliberate: the two bars answer different questions and sharing one function through a flag
would make every line of it read "if we know the total".

- [ ] **Step 4: Run the tests**

Run: `node --test test/caption.test.js test/progress.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/caption.js src/progress.js test/caption.test.js test/progress.test.js
git commit -m "feat: a caption and a progress line for a transfer with no known total"
```

---

### Task 3: `ChunkReader` — at most N bytes from a Readable into a file

**Files:**
- Create: `src/stream.js`
- Test: `test/stream.test.js`

**Interfaces:**
- Produces: `new ChunkReader(readable)` with
  `async fill(handle, limit) -> { bytes, eof }`. `bytes` is how many were written to
  `handle` (0 only at a clean end), `eof` says the stream produced its last byte.
  Backpressure comes free: the reader pulls from an async iterator, so while the caller is
  uploading, nothing is being pulled and the child blocks on its own write.

- [ ] **Step 1: Write the failing test**

```js
import { Readable } from 'node:stream'

test('fills exactly the limit and keeps the remainder for the next chunk', async () => {
  const dir = await tempDir('stream')
  const file = path.join(dir, 'chunk')
  const reader = new ChunkReader(Readable.from([Buffer.from('abcde'), Buffer.from('fghij')]))

  let handle = await fs.open(file, 'w')
  const first = await reader.fill(handle, 4)
  await handle.close()

  assert.deepEqual(first, { bytes: 4, eof: false })
  assert.equal(await fs.readFile(file, 'utf8'), 'abcd')

  handle = await fs.open(file, 'w')
  const second = await reader.fill(handle, 4)
  await handle.close()

  assert.deepEqual(second, { bytes: 4, eof: false })
  assert.equal(await fs.readFile(file, 'utf8'), 'efgh')
})

test('a stream shorter than the limit reports eof with what it had', async () => {
  const dir = await tempDir('stream')
  const file = path.join(dir, 'chunk')
  const reader = new ChunkReader(Readable.from([Buffer.from('abc')]))
  const handle = await fs.open(file, 'w')
  const result = await reader.fill(handle, 100)
  await handle.close()

  assert.deepEqual(result, { bytes: 3, eof: true })
})

test('an empty stream reports eof and no bytes', async () => {
  const dir = await tempDir('stream')
  const handle = await fs.open(path.join(dir, 'chunk'), 'w')
  const result = await new ChunkReader(Readable.from([])).fill(handle, 100)
  await handle.close()

  assert.deepEqual(result, { bytes: 0, eof: true })
})

test('a stream that ends exactly on a limit reports eof on the next fill, not this one', async () => {
  const dir = await tempDir('stream')
  const file = path.join(dir, 'chunk')
  const reader = new ChunkReader(Readable.from([Buffer.from('abcd')]))

  let handle = await fs.open(file, 'w')
  assert.deepEqual(await reader.fill(handle, 4), { bytes: 4, eof: false })
  await handle.close()

  handle = await fs.open(file, 'w')
  assert.deepEqual(await reader.fill(handle, 4), { bytes: 0, eof: true })
  await handle.close()
})

test('an error from the stream is thrown, not read as an end', async () => {
  const dir = await tempDir('stream')
  const handle = await fs.open(path.join(dir, 'chunk'), 'w')
  const broken = Readable.from((async function* () {
    yield Buffer.from('ab')
    throw new Error('producer exploded')
  })())

  await assert.rejects(() => new ChunkReader(broken).fill(handle, 100), /producer exploded/)
  await handle.close()
})
```

The last test is the one that matters most: a stream error read as an end is exactly the
silent truncation this whole feature exists to refuse.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/stream.test.js`
Expected: FAIL — cannot find module `../src/stream.js`.

- [ ] **Step 3: Implement `src/stream.js`**

```js
// One reader over the life of an upload: it holds the iterator, so the bytes a chunk did
// not want are the first bytes of the next chunk rather than something dropped between
// two reads. Pulling through an async iterator is also what gives backpressure for free —
// while a chunk uploads, nothing calls next(), so the child blocks on its own write and
// the backlog stays in the pipe instead of in this process.
export class ChunkReader {
  constructor(readable) {
    this.iterator = readable[Symbol.asyncIterator]()
    this.pending = null
    this.ended = false
  }

  // Writes at most `limit` bytes into `handle`. `eof` means the stream is finished and
  // there will never be more — reported on the fill that meets the end, and on every one
  // after it.
  async fill(handle, limit) {
    let bytes = 0

    while (bytes < limit) {
      if (this.pending === null) {
        if (this.ended) break

        const { value, done } = await this.iterator.next()

        if (done) {
          this.ended = true
          break
        }

        this.pending = value
      }

      const room = limit - bytes
      const take = this.pending.length <= room ? this.pending : this.pending.subarray(0, room)

      await handle.write(take)
      bytes += take.length

      this.pending =
        take.length === this.pending.length ? null : this.pending.subarray(take.length)
    }

    return { bytes, eof: this.ended && this.pending === null }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/stream.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stream.js test/stream.test.js
git commit -m "feat: read a stream one chunk at a time, keeping the remainder"
```

---

### Task 4: the spawn seam

**Files:**
- Create: `src/spawn.js`
- Test: `test/spawn.test.js`

**Interfaces:**
- Produces: `spawnProducer(argv, { onSpawnError })` returning
  `{ stdout, exited, kill(signal) }` where `stdout` is a Readable and `exited` is a Promise
  resolving `{ code, signal }` — never rejecting for a non-zero exit, because a non-zero exit
  is an answer, not a failure of this function. A command that cannot start rejects `exited`
  with a message naming the command.

- [ ] **Step 1: Write the failing test**

```js
test('a command that exits 0 resolves with its code and its output', async () => {
  const child = spawnProducer(['sh', '-c', 'printf hello'])
  const chunks = []
  for await (const buf of child.stdout) chunks.push(buf)

  assert.equal(Buffer.concat(chunks).toString(), 'hello')
  assert.deepEqual(await child.exited, { code: 0, signal: null })
})

test('a non-zero exit is an answer, not a thrown error', async () => {
  const child = spawnProducer(['sh', '-c', 'exit 3'])
  for await (const _ of child.stdout) { /* drain */ }

  assert.deepEqual(await child.exited, { code: 3, signal: null })
})

test('a command that does not exist names itself', async () => {
  const child = spawnProducer(['telstore-no-such-command-9f3a'])

  await assert.rejects(() => child.exited, /telstore-no-such-command-9f3a/)
})

test('kill stops a command that would otherwise run forever', async () => {
  const child = spawnProducer(['sh', '-c', 'sleep 30'])
  child.kill('SIGTERM')

  const { signal } = await child.exited
  assert.equal(signal, 'SIGTERM')
})
```

These run real processes on purpose: `sh` and `sleep` are the two things this module exists
to talk to, and a fake child cannot show that `stdio` was wired the way Node actually wires
it. This is the same reasoning `test/downloader.test.js` uses for driving the real
`iterDownload`. See `docs/design/testing-blind-spots.md`.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/spawn.test.js`
Expected: FAIL — cannot find module `../src/spawn.js`.

- [ ] **Step 3: Implement `src/spawn.js`**

```js
import { spawn } from 'node:child_process'

// stderr is inherited, never captured: when tar fails it explains itself in tar's own words,
// on the stream the user is already watching. telstore adds the exit code and what it did
// about it, and does not paraphrase.
export function spawnProducer(argv, { stdio = ['ignore', 'pipe', 'inherit'] } = {}) {
  const [command, ...args] = argv
  const child = spawn(command, args, { stdio })

  const exited = new Promise((resolve, reject) => {
    child.on('error', (err) => {
      reject(
        new Error(
          err.code === 'ENOENT'
            ? `Cannot run ${command}: no such command on this machine.`
            : `Cannot run ${command}: ${err.message}`,
        ),
      )
    })

    child.on('close', (code, signal) => resolve({ code, signal }))
  })

  return {
    stdout: child.stdout,
    stdin: child.stdin,
    exited,
    kill: (signal = 'SIGTERM') => child.kill(signal),
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/spawn.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/spawn.js test/spawn.test.js
git commit -m "feat: a spawn seam that reports a command's exit code"
```

---

### Task 5: stream records in `state.js`

**Files:**
- Modify: `src/state.js` (`streamKey`, `canResume`)
- Test: `test/state.test.js`

**Interfaces:**
- Produces: `streamKey(backupId)` — a key in the same 40-hex shape `stateKey` produces, so
  the two namespaces cannot collide and `recordNames` needs no change. A stream record is
  `{ v: 1, kind: 'stream', id, chat, name, chunkSize, done: { '0': { msgId, size, sha256 } } }`
  — the `done` shape is unchanged, which is what lets `stateMessageIds` in `delete` read it.
  `canResume(key, state)` returns `{ ok: false, reason: 'stream' }` for it, without stat-ing.

- [ ] **Step 1: Write the failing test**

```js
test('a stream record is never resumable, and answers without touching the disk', async () => {
  const state = { v: 1, kind: 'stream', id: 'telstore-1', chat: '@c', name: 'a.tar', done: {} }

  assert.deepEqual(await canResume(streamKey('telstore-1'), state), { ok: false, reason: 'stream' })
})

test('a stream key is filed beside uploads and found by its backup id', async () => {
  const dir = await tempDir('state')
  const key = streamKey('telstore-1')
  await saveState(key, { v: 1, kind: 'stream', id: 'telstore-1', chat: '@c', done: {} }, dir)

  const found = await findStates('telstore-1', dir)
  assert.equal(found.length, 1)
  assert.equal(found[0].state.kind, 'stream')
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/state.test.js`
Expected: FAIL — `streamKey` is not exported; `canResume` stats `state.path` and reports
`missing`.

- [ ] **Step 3: Implement**

```js
// stateKey hashes path:size:mtime, and a stream has none of the three. What holds still is
// the backup id, and hashing it keeps the file name in the same 40-hex shape the directory
// already sorts, prunes and filters on.
export function streamKey(backupId) {
  return createHash('sha1').update(`stream:${backupId}`).digest('hex')
}
```

In `canResume`, before anything touches the filesystem:

```js
  // A stream cannot be resumed by anyone, so this is not a question about a file. Answering
  // it by stat-ing state.path would report "missing" for a record that never had a path,
  // and status would then offer a resume command that starts a brand new backup.
  if (state.kind === 'stream') return { ok: false, reason: 'stream' }
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/state.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state.js test/state.test.js
git commit -m "feat: a state record for a backup that cannot be resumed"
```

---

### Task 6: `runStreamUpload` — the loop and the manifest condition

**Files:**
- Create: `src/commands/upload-stream.js`
- Modify: `src/commands/upload.js` (export `LONG_WAIT_MS`, `ANNOUNCE_AFTER_ATTEMPT` and the
  `onRetry` factory so the wording is not written twice)
- Test: `test/upload-stream.test.js`

**Interfaces:**
- Consumes: `ChunkReader` (Task 3), `spawnProducer` (Task 4), `streamKey` (Task 5),
  `chunkCaption` with a null total and `createStreamProgress` (Task 2), and the untouched
  `uploadRange`, `buildManifest`, `serializeManifest`, `manifestCaption`, `saveState`,
  `markChunkDone`, `clearState`, `pruneStates`.
- Produces: `runStreamUpload(name, childArgv, options = {}, deps = {})` returning
  `{ id, chunks, size }`. `deps` mirrors `runUpload`'s and adds `spawn = spawnProducer` and
  `deleteMessages = realDeleteMessages`.

- [ ] **Step 1: Write the failing tests (happy path only; failures are Task 7)**

```js
import { fakeClient, uploadDeps, tempDir, collect, LOGGED_IN } from './helpers.js'

// A producer under test is a plain Readable and a promise: the fake stands in for
// spawnProducer, not for a shell, so nothing here depends on /bin/sh being anywhere.
function fakeSpawn(chunks, { code = 0, signal = null } = {}) {
  return () => ({
    stdout: Readable.from(chunks),
    exited: Promise.resolve({ code, signal }),
    kill: () => {},
  })
}

test('a command that exits 0 becomes a backup of exactly what it wrote', async () => {
  const dir = await tempDir('stream-upload')
  await writeConfig(dir, { ...LOGGED_IN, settings: { chat: '@store' } })
  const client = fakeClient()
  const out = collect()

  const result = await runStreamUpload('a.tar', ['tar', 'cf', './a'], { chunkSize: '10' }, {
    ...uploadDeps(client),
    configDir: dir,
    spawn: fakeSpawn([Buffer.alloc(10, 1), Buffer.alloc(5, 2)]),
    partSize: 4,
    log: out.log,
    writeErr: () => {},
  })

  assert.equal(result.chunks, 2)
  assert.equal(result.size, 15)

  const manifest = JSON.parse(client.messages.at(-1).bytes.toString())
  assert.equal(manifest.size, 15)
  assert.equal(manifest.name, 'a.tar')
  assert.deepEqual(manifest.chunks.map((c) => c.size), [10, 5])
})

test('the bytes in the chat are the bytes the command wrote', async () => {
  // ...same setup...
  const sent = Buffer.concat(
    client.messages.filter((m) => !m.fileName.endsWith('.manifest.json')).map((m) => m.bytes),
  )
  assert.deepEqual(sent, Buffer.concat([Buffer.alloc(10, 1), Buffer.alloc(5, 2)]))
})

test('a chunk from a stream is captioned without a total', async () => {
  // ...same setup...
  assert.match(client.messages[0].caption, /· 1$/)
})

test('a command that writes nothing is refused, and nothing is sent', async () => {
  await assert.rejects(
    () => runStreamUpload('a.tar', ['true'], {}, { ...deps, spawn: fakeSpawn([]) }),
    /wrote nothing/,
  )
  assert.equal(client.messages.length, 0)
})

test('the record is cleared once the manifest is in the chat', async () => {
  // ...run the happy path, then...
  assert.deepEqual(await findStates(result.id, dir), [])
})
```

`writeConfig` is whatever `test/upload.test.js` already uses to write a config into a temp
dir — read that file and reuse it rather than inventing a second one.

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/upload-stream.test.js`
Expected: FAIL — cannot find module `../src/commands/upload-stream.js`.

- [ ] **Step 3: Implement the loop**

The shape, with the parts that matter written out:

```js
const id = newBackupId()
const key = streamKey(id)
const tmp = path.join(configDir, 'tmp')
await fs.mkdir(tmp, { recursive: true })

const child = spawn(childArgv)
const reader = new ChunkReader(child.stdout)
const sent = []           // message ids, in order, for the rollback
let size = 0
let i = 0

for (;;) {
  const file = path.join(tmp, `${id}-${i}.chunk`)
  const handle = await fs.open(file, 'w+')
  let bytes
  let eof

  try {
    ;({ bytes, eof } = await reader.fill(handle, chunkSize))

    if (bytes > 0) {
      // Uploading from offset 0 of a file that holds exactly this chunk: uploadRange does
      // not know or care that the bytes arrived through a pipe.
      const { inputFile, sha256 } = await uploadRange(client, handle.fd, {
        offset: 0, length: bytes, fileName: chunkFileName(id, i), concurrency, partSize,
        onProgress: (n) => progress.advance(n), retryOptions: { ...retryOptions, onRetry },
      })

      const message = await sendChunk(client, chat, {
        inputFile,
        fileName: chunkFileName(id, i),
        caption: chunkCaption({ id, number: i + 1, total: null }),
      })

      sent.push(message.id)
      state = await markChunkDone(key, state, i, { msgId: message.id, size: bytes, sha256 }, configDir)
      size += bytes
      i += 1
    }
  } finally {
    await handle.close()
    await fs.rm(file, { force: true })
  }

  if (eof) break

  if (i >= MAX_CHUNKS) {
    throw new Error(
      `This command has already produced ${MAX_CHUNKS} chunks of ${formatBytes(chunkSize)} ` +
        'and has not finished. Run again with a larger --chunk-size.',
    )
  }
}
```

Then the condition the whole feature rests on:

```js
// The stream's answer to the file path's re-stat. An EOF after a crash and an EOF after
// success are the same event on this end of the pipe; the exit code is the only thing that
// tells them apart, and a manifest sent without it would describe a truncated archive that
// restores perfectly and is garbage.
const { code, signal } = await child.exited

if (code !== 0 || signal !== null) {
  throw new Error(
    signal !== null
      ? `${childArgv[0]} was killed by ${signal} after writing ${formatBytes(size)}. ` +
        'telstore is not sending the manifest: what it wrote is an unfinished file.'
      : `${childArgv[0]} exited ${code} after writing ${formatBytes(size)}. ` +
        'telstore is not sending the manifest: what it wrote is an unfinished file.',
  )
}

if (size === 0) {
  throw new Error(`${childArgv[0]} wrote nothing, so there is no backup to make.`)
}
```

Only then `buildManifest` / `sendManifest` / `clearState`, exactly as `runUpload` does.
The state record is written before the first chunk with
`{ v: 1, kind: 'stream', id, chat: String(chat), name, chunkSize, done: {} }` and
`pruneStates` is called after it, with the same stderr report `runUpload` makes.

- [ ] **Step 4: Run the tests**

Run: `node --test test/upload-stream.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/upload-stream.js src/commands/upload.js test/upload-stream.test.js
git commit -m "feat: a backup made from a command's output"
```

---

### Task 7: rollback — every failure removes what it sent

**Files:**
- Modify: `src/commands/upload-stream.js`
- Test: `test/upload-stream.test.js`

**Interfaces:**
- Consumes: `deleteMessages(client, peer, ids, { retryOptions, onBatch })` from
  `src/client.js`, injected through `deps.deleteMessages` so the fake client sees it.
- Produces: no new export. On any failure the function still throws; what changes is that the
  chat is empty afterwards and the record is gone.

- [ ] **Step 1: Write the failing tests**

```js
test('a producer that dies leaves nothing behind in the chat', async () => {
  const removed = []
  await assert.rejects(
    () => runStreamUpload('a.tar', ['tar', 'cf', './a'], { chunkSize: '10' }, {
      ...deps,
      spawn: fakeSpawn([Buffer.alloc(10, 1), Buffer.alloc(10, 2)], { code: 2 }),
      deleteMessages: async (_c, _peer, ids) => { removed.push(...ids) },
    }),
    /exited 2/,
  )

  const chunkIds = client.messages
    .filter((m) => !m.fileName.endsWith('.manifest.json'))
    .map((m) => m.id)

  assert.deepEqual(removed, chunkIds)
  assert.equal(client.messages.some((m) => m.fileName.endsWith('.manifest.json')), false)
})

test('the record goes when the rollback succeeds', async () => {
  // ...as above, then...
  assert.deepEqual(await findStates(id, dir), [])
})

test('a rollback that fails keeps the record and says what to run', async () => {
  const err = await assert.rejects(
    () => runStreamUpload('a.tar', ['tar', 'c'], { chunkSize: '10' }, {
      ...deps,
      spawn: fakeSpawn([Buffer.alloc(10, 1)], { code: 2 }),
      deleteMessages: async () => { throw new Error('connection dropped') },
    }),
  )

  assert.match(err.message, /npx telstore delete telstore-/)
  assert.equal((await findStates(idFromMessages(client), dir)).length, 1)
})

test('a chunk that Telegram refuses rolls back the chunks before it', async () => {
  // fakeClient({ failOnChunk: 1 }) — the second chunk throws
  // expect: the first chunk's message id was deleted, no manifest, error reaches the caller
})

test('more chunks than MAX_CHUNKS rolls back and names --chunk-size', async () => {
  // chunkSize 1 with a stream of MAX_CHUNKS + 1 bytes is too slow to run; instead inject
  // maxChunks through deps (default MAX_CHUNKS) and use 3.
})
```

The last test needs `maxChunks` in `deps`, defaulting to the real `MAX_CHUNKS`. Add it — a
constant a test cannot lower is a branch no test will ever reach.

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/upload-stream.test.js`
Expected: FAIL — chunks stay in the chat, the record survives.

- [ ] **Step 3: Implement**

Wrap everything after the record is created in `try/catch`, and on the way out:

```js
// A stream cannot be resumed, so chunks left in the chat are chunks nothing will ever point
// at again — the opposite of the file path, where they are kept precisely so a second run
// can carry on onto them. Removing them is part of failing, not a courtesy.
async function rollback(err) {
  if (sent.length === 0) {
    await clearState(key, configDir)
    throw err
  }

  warn(`\nRemoving the ${plural(sent.length, 'chunk')} this run already sent...\n`)

  try {
    await deleteMessages(client, chat, sent, { retryOptions })
    await clearState(key, configDir)
  } catch (cleanupErr) {
    // The record is the only list of these message ids, so it stays. `delete` reads it
    // through findStates when there is no manifest, which is exactly this situation.
    throw new Error(
      `${err.message}\n\ntelstore then could not remove the ${plural(sent.length, 'chunk')} ` +
        `it had sent: ${cleanupErr.message}. They are still in ${chat}, and there is no ` +
        `manifest pointing at them. Run "npx telstore delete ${id}" to remove them.`,
    )
  }

  throw err
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/upload-stream.test.js && npm test`
Expected: PASS, whole suite green.

- [ ] **Step 5: Commit**

```bash
git add src/commands/upload-stream.js test/upload-stream.test.js
git commit -m "fix: a failed stream upload removes the chunks it sent"
```

---

### Task 8: wire it up, and make Ctrl-C wait for the rollback

**Files:**
- Modify: `bin/telstore.js`, `src/cli.js` (`interruptMessage`)
- Test: `test/bin.test.js`, `test/cli.test.js`

**Interfaces:**
- Consumes: `route(...).childArgv` (Task 1), `runStreamUpload` (Tasks 6-7).
- Produces: `interruptMessage('upload', { backupId, done, stream: true })` — the existing
  call sites pass no `stream`, so the file wording is unchanged.

- [ ] **Step 1: Write the failing tests**

```js
// test/cli.test.js
test('Ctrl-C during a stream upload does not promise a resume that cannot happen', () => {
  const message = interruptMessage('upload', { backupId: 'telstore-1', stream: true })

  assert.match(message, /cannot be resumed/)
  assert.match(message, /removing/i)
  assert.doesNotMatch(message, /run the same command again to continue/i)
})

test('a second Ctrl-C leaves the id and the way to clean up by hand', () => {
  const message = interruptMessage('upload', { backupId: 'telstore-1', stream: true, again: true })

  assert.match(message, /npx telstore delete telstore-1/)
})
```

```js
// test/bin.test.js — the binary really runs, as the existing tests in this file do
test('a stream upload with no login fails before it runs the command', async () => {
  const { code, stderr } = await runBin(['a.tar', '--', 'sh', '-c', 'echo hi'], { home })
  assert.equal(code, 1)
  assert.match(stderr, /log in/i)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/cli.test.js test/bin.test.js`
Expected: FAIL — `interruptMessage` has no stream branch; the binary has no arm for it.

- [ ] **Step 3: Implement**

In `bin/telstore.js`, inside `case 'upload'`:

```js
if (parsed.childArgv) {
  const { runStreamUpload } = await import('../src/commands/upload-stream.js')

  await runStreamUpload(parsed.args[0], parsed.childArgv, parsed.options, {
    onBackupId: (id) => { currentBackupId = id },
    // SIGINT arrives on a process that is mid-transfer, and the rollback needs a network
    // round trip per batch of messages. process.exit here would leave exactly the chunks
    // this feature promises never to leave.
    onAbortable: (abort) => { currentAbort = abort },
  })
  return
}
```

And the SIGINT handler becomes:

```js
let currentAbort = null
let interrupting = false

process.on('SIGINT', () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false)

  // A second Ctrl-C is someone saying they will not wait. Say what is still in the chat
  // and how to remove it, then go.
  if (interrupting) {
    process.stderr.write(
      interruptMessage(currentCommand, {
        backupId: currentBackupId, done: finished, stream: true, again: true,
      }),
    )
    process.exit(SIGINT_EXIT_CODE)
  }

  if (!currentAbort) {
    process.stderr.write(interruptMessage(currentCommand, { backupId: currentBackupId, done: finished }))
    process.exit(SIGINT_EXIT_CODE)
  }

  interrupting = true
  process.stderr.write(
    interruptMessage(currentCommand, { backupId: currentBackupId, done: finished, stream: true }),
  )
  currentAbort()
})
```

`runStreamUpload` calls `deps.onAbortable(fn)` with a function that kills the child and makes
the loop throw, so the existing rollback runs and the process leaves with 130 on its own.

`interruptMessage` gains its branch:

```js
  if (command === 'upload' && stream) {
    if (again) {
      return (
        `\nLeaving now. Backup ${backupId} has chunks in the chat with no manifest pointing ` +
        `at them — run "npx telstore delete ${backupId}" to remove them.\n`
      )
    }

    return (
      `\nStopping. A backup made from a command cannot be resumed, so telstore is removing ` +
      'the chunks it already sent. This takes a moment — press Ctrl-C again to leave now ' +
      'and clean up by hand.\n'
    )
  }
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add bin/telstore.js src/cli.js test/bin.test.js test/cli.test.js
git commit -m "feat: Ctrl-C during a stream upload cleans up before it leaves"
```

---

### Task 9: `status` and `delete` tell the truth about a stream record

**Files:**
- Modify: `src/commands/status.js`, `src/commands/delete.js`
- Test: `test/status.test.js`, `test/delete.test.js`

**Interfaces:**
- Consumes: `canResume` returning `{ ok: false, reason: 'stream' }` (Task 5), records with
  `kind: 'stream'` and a `name` instead of a `path`.

- [ ] **Step 1: Write the failing tests**

```js
// test/status.test.js
test('a stream record is leftover chunks, not an unfinished upload to resume', async () => {
  const dir = await tempDir('status')
  await saveState(streamKey('telstore-1'), {
    v: 1, kind: 'stream', id: 'telstore-1', chat: '@store', name: 'a.tar',
    done: { 0: { msgId: 5, size: 10, sha256: 'x' } },
  }, dir)

  const out = collect()
  await runStatus({}, { configDir: dir, log: out.log, connect: async () => { throw new Error('offline') } })

  assert.match(out.text(), /a\.tar/)
  assert.match(out.text(), /npx telstore delete telstore-1/)
  assert.doesNotMatch(out.text(), /npx telstore a\.tar/)
})
```

```js
// test/delete.test.js
test('a stream record with no manifest is described by its name, not a path it never had', async () => {
  // saveState a stream record, no manifest in the fake chat
  // expect the printed line to name a.tar and not "undefined"
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/status.test.js test/delete.test.js`
Expected: FAIL — `status` prints a resume command built from `record.path` (undefined), and
`delete` prints `File undefined`.

- [ ] **Step 3: Implement**

In `status.js`, where a record is rendered, branch on `reason === 'stream'`:

```js
  // A stream record is not an unfinished transfer waiting to be picked up; it is a set of
  // chunks in a chat with nothing pointing at them, which is a different sentence and a
  // different command.
  if (resume.reason === 'stream') {
    lines.push(field('Backup', record.state.id))
    lines.push(field('From', `${record.state.name} (a command's output)`))
    lines.push(field('Left behind', `${plural(chunkCount, 'chunk')} in ${record.state.chat}`))
    lines.push(field('Remove', `npx telstore delete ${shellArg(record.state.id)}`))
    return lines
  }
```

In `delete.js`, the no-manifest branch currently prints `describeName(record.state.path)`;
make it prefer `name` when the record has one:

```js
    log(`File   ${describeName(record.state.name ?? record.state.path)}`)
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/status.js src/commands/delete.js test/status.test.js test/delete.test.js
git commit -m "fix: status and delete describe a stream record for what it is"
```

---

### Task 10: documentation

**Files:**
- Modify: `README.md`, `src/cli.js` (`HELP`), `docs/design/batches.md`,
  `docs/design/data-integrity.md`, `docs/design/module-boundaries.md`,
  `docs/design/captions.md`, `CLAUDE.md` (the table row)
- Test: `test/bin.test.js` (the help text is already asserted there — check what it expects)

- [ ] **Step 1: README**

A section after "Several files at once", covering: the two example lines, that the command's
exit code decides whether the manifest is sent, that a failed run removes what it sent, that
there is no resume, and that `-- sh -c '...'` is how a pipeline (compression, `age`, `gpg`)
gets in. Add one line to "Limits worth knowing": a backup made from a command cannot be
resumed, and Ctrl-C removes what was sent rather than keeping it.

- [ ] **Step 2: HELP in `src/cli.js`**

Two usage lines and a short paragraph, in the register the rest of the file uses.

- [ ] **Step 3: The design docs**

- `data-integrity.md`: the exit-code biconditional, said as the stream's answer to the
  re-stat, and why rollback is right here and wrong on the file path.
- `batches.md`: why a stream upload has no batch — no list to confirm, nothing to skip.
- `module-boundaries.md`: `src/spawn.js` is the seam, `src/stream.js` is pure, and
  `uploader.js` was not touched because a temp file is an fd.
- `captions.md`: a stream chunk's caption has no total, and nothing parses chunk captions.
- `CLAUDE.md`: add `src/stream.js`, `src/spawn.js`, `src/commands/upload-stream.js` to the
  rows they belong to.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS, 698 + new tests.

- [ ] **Step 5: Commit**

```bash
git add README.md src/cli.js docs/design CLAUDE.md
git commit -m "docs: a backup made from a command"
```

---

### Task 11: meet a real account

**Files:** none — this runs the `e2e` skill (`.claude/skills/e2e/`).

The fake client cannot see whether a rollback removed anything from Telegram, and that is the
central claim of this feature. `docs/design/testing-blind-spots.md` is the standing record of
what that blindness has already cost.

- [ ] **Step 1:** Read `.claude/skills/e2e/` and follow it — temporary `HOME`, throwaway chat,
      never the real backup chat.
- [ ] **Step 2:** `telstore dir.tar -- tar cf - ./somedir` with a directory larger than one
      chunk (set `--chunk-size` small enough to force at least three), then restore it with
      today's `restore` and compare sha256 against `tar cf -` of the same tree.
- [ ] **Step 3:** `telstore x.tar -- sh -c 'head -c 20000000 /dev/urandom; exit 1'` with a
      chunk size that forces two chunks — then assert the chat is **empty**: no chunks, no
      manifest. This is the assertion no fake can make.
- [ ] **Step 4:** Ctrl-C mid-upload (SIGINT to the process while chunk 2 is in flight), then
      confirm the chat is empty and `status` reports nothing.
- [ ] **Step 5:** Add these three to the skill's not-optional list, in the skill's own words.
- [ ] **Step 6:** Commit whatever the skill file gained.

---

## Self-Review

**Spec coverage.** Every section of the spec that concerns the upload direction has a task:
CLI surface (1), captions and progress (2), the chunk loop and temp files (3, 6), the spawn
seam and exit code (4, 6), state record (5), rollback (7), Ctrl-C (8), status/delete (9),
docs (10), e2e (11). The restore direction is deliberately stage 2 and is named as such in
the header.

**Placeholders.** Task 7 leaves two test bodies as comments rather than code. That is
deliberate and marked: both need the surrounding fixture from the tests above them in the
same file, and writing them out here would be a copy that drifts. Every other step carries
its own code.

**Type consistency.** `childArgv` (Task 1) is the name used in Tasks 6 and 8. `streamKey`
(Task 5) is the name used in Tasks 6 and 9. `spawnProducer` (Task 4) is what `deps.spawn`
defaults to in Task 6. `ChunkReader#fill(handle, limit) -> { bytes, eof }` (Task 3) is called
with exactly that shape in Task 6.

**Known risk carried into execution:** `deps.maxChunks` is introduced in Task 7 as a testing
seam. It must default to the real `MAX_CHUNKS` from `chunking.js` and must not become a flag.
