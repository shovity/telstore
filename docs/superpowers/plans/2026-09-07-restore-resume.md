# Restore Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An interrupted restore carries on from what its `.partial` file already
holds, instead of downloading the whole backup again.

**Architecture:** The evidence is the `.partial` file itself. On a rerun, each
chunk-sized region is hashed against the sha256 the manifest already records and
compared in order; the first region that does not match is where downloading
resumes. A record under `~/.telstore/state/` exists only so `status` can list
unfinished restores — nothing on the resume path reads it, so a missing, stale or
hand-edited record cannot produce a wrong file.

**Tech Stack:** Node 18+, pure ESM, no build step. `node:test` only. One runtime
dependency (`teleproto`) — this plan adds none.

**Spec:** `docs/superpowers/specs/2026-09-07-restore-resume-design.md`

## Global Constraints

- **English-only.** Code, comments, user-facing strings, test names, docs and
  commit messages. (`CLAUDE.md`)
- **Style:** no semicolons, single quotes, two-space indent.
- **Node 18+, pure ESM, no TypeScript, no transpilation.**
- **No new dependencies.** `teleproto` is the only runtime dependency.
- **Tests use `node:test` only.** `npm test` is the whole gate.
- **Never produce wrong data silently.** A restore that cannot reproduce the
  original bytes must fail rather than hand over a plausible-looking file. No
  check in this plan may be relaxed to make a test pass.
- **Commands take collaborators through a `deps` object** so tests can pass
  fakes.
- Before changing `src/manifest.js`, `src/state.js`, `src/chunking.js` or
  `src/config.js`, read `docs/design/data-integrity.md`. Before changing
  `src/client.js`, `src/uploader.js`, `src/downloader.js` or `bin/telstore.js`,
  read `docs/design/module-boundaries.md`. Before `runRestores`, read
  `docs/design/batches.md`.

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `src/downloader.js` | unchanged responsibility; `hashRange` becomes exported so restore verifies an assembled range through the one definition of that check |
| `src/commands/restore.js` | owns the resume narrative: open, scan, skip, download, record |
| `src/state.js` | gains a second record namespace (`restore-*`) that shares the directory with uploads but never their prune queue |
| `src/commands/status.js` | lists both kinds in one `Unfinished` block |
| `src/cli.js` | `interruptMessage` tells the truth about restore |
| `bin/telstore.js` | wires the restore id and finished ids into the SIGINT handler |

Task 1 alone delivers working resume. Tasks 2–5 add the `status` and
interruption layer on top of it.

---

### Task 1: Resume from the `.partial` file

**Files:**
- Modify: `src/downloader.js:41` (export `hashRange`)
- Modify: `src/commands/restore.js:132-193`
- Modify: `docs/design/data-integrity.md`
- Modify: `CLAUDE.md`
- Test: `test/restore.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export async function hashRange(fd, offset, length): Promise<string>`
  from `src/downloader.js` — hex sha256 of the byte range. Used by nothing else
  in this plan.

- [ ] **Step 1: Write the failing tests**

Add to `test/restore.test.js`. `fakeBackup()` builds a 1000-byte backup in three
chunks of 400/400/200 with message ids 1000, 1001, 1002.

```js
// Records which chunk messages a run actually fetched. A resumed restore is only
// resumed if it never asked for the chunks it claims to have skipped.
function watchGetMessage(base, asked) {
  return {
    ...base,
    getMessage: (c, peer, msgId) => {
      asked.push(msgId)
      return c.getMessage(peer, msgId)
    },
  }
}

test('resumes from a .partial that already holds the first chunks', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  const partial = Buffer.alloc(1000)
  backup.content.copy(partial, 0, 0, 800)
  await fs.writeFile(`${out}.partial`, partial)

  const asked = []
  await runRestore(backup.id, { out }, watchGetMessage(deps(fakeClient(backup), configDir), asked))

  assert.deepEqual(asked, [1002])
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('a corrupt region in the .partial re-downloads it and everything after it', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  // Every byte is right except one inside chunk 2. Chunk 3 is byte-perfect and is
  // still re-fetched: what is already there is a prefix, and the scan stops at the
  // first thing it cannot vouch for rather than picking survivors out of the middle.
  const partial = Buffer.from(backup.content)
  partial[500] ^= 0xff
  await fs.writeFile(`${out}.partial`, partial)

  const asked = []
  await runRestore(backup.id, { out }, watchGetMessage(deps(fakeClient(backup), configDir), asked))

  assert.deepEqual(asked, [1001, 1002])
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('a .partial shorter than the file resumes at the right chunk', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  await fs.writeFile(`${out}.partial`, backup.content.subarray(0, 400))

  const asked = []
  await runRestore(backup.id, { out }, watchGetMessage(deps(fakeClient(backup), configDir), asked))

  assert.deepEqual(asked, [1001, 1002])
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('a .partial matching nothing is downloaded over from the start', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  await fs.writeFile(`${out}.partial`, randomBytes(1000))

  const asked = []
  await runRestore(backup.id, { out }, watchGetMessage(deps(fakeClient(backup), configDir), asked))

  assert.deepEqual(asked, [1000, 1001, 1002])
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('a complete .partial is renamed without downloading anything', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  // What a run that died between its last chunk and the rename leaves behind.
  await fs.writeFile(`${out}.partial`, backup.content)

  const asked = []
  await runRestore(backup.id, { out }, watchGetMessage(deps(fakeClient(backup), configDir), asked))

  assert.deepEqual(asked, [])
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('a fresh restore never scans for anything to resume', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const seen = collect()

  await runRestore(backup.id, { out }, {
    ...deps(fakeClient(backup), configDir),
    silent: false,
    log: seen.log,
    writeErr: () => {},
  })

  assert.doesNotMatch(seen.text(), /Checking what is already/)
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('a .partial that cannot be opened stops the restore rather than starting over', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  // A directory where the .partial belongs: open fails with something that is not ENOENT.
  // Treating that as "no file yet" would truncate nothing, download everything, and fail
  // only at the rename — two hours later, for a reason nobody could read off the error.
  await fs.mkdir(`${out}.partial`)

  await assert.rejects(() => runRestore(backup.id, { out }, deps(fakeClient(backup), configDir)))
})

test('a resumed restore names the chunks it skipped', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const seen = collect()

  const partial = Buffer.alloc(1000)
  backup.content.copy(partial, 0, 0, 400)
  await fs.writeFile(`${out}.partial`, partial)

  await runRestore(backup.id, { out }, {
    ...deps(fakeClient(backup), configDir),
    silent: false,
    log: seen.log,
    writeErr: () => {},
  })

  assert.match(seen.text(), /Chunk 1\/3 already restored, skipping\./)
  assert.doesNotMatch(seen.text(), /Chunk 2\/3 already restored/)
})
```

Add `collect` to the existing helpers import at the top of the file:

```js
import { collect, tempDir } from './helpers.js'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — the new tests report the wrong `asked` arrays (every chunk is
fetched, because `w+` truncated the `.partial` before anything looked at it).

- [ ] **Step 3: Export `hashRange`**

In `src/downloader.js`, change the declaration at line 41. Leave the comment
above it as it is and add one line to it:

```js
// The digest is taken from the assembled range on disk rather than from the buffers as they
// arrive. Once slices land out of order that is the only order left to hash in, and it is
// the better check anyway: a slice written at the wrong offset, two slices overlapping, or
// one silently skipped all show up here. It does not prove the bytes reached the platter —
// this read may well be served from the page cache — it proves the assembly.
//
// Exported because a resumed restore asks the same question of a .partial left by an earlier
// run. A second copy of it in restore.js is how two definitions of one check start to differ.
export async function hashRange(fd, offset, length) {
```

- [ ] **Step 4: Add the scan to `src/commands/restore.js`**

Change the import at line 14:

```js
import { downloadToFile, hashRange } from '../downloader.js'
```

Add this function above `runRestore` (after `safeOutName`):

```js
// How many chunks at the front of a .partial already hold what the manifest says they
// should. The evidence is the file, never a record: a record makes claims about a local
// file anyone can edit between runs, and a claim that is wrong here renames a corrupt file
// into place. Every chunk in the finished file was hashed against the manifest by the run
// that renamed it, whether this run downloaded it or found it already there.
async function scanPartial(handle, manifest, log) {
  let done = 0

  for (const chunk of manifest.chunks) {
    const digest = await hashRange(handle.fd, chunk.i * manifest.chunkSize, chunk.size)

    // Downloads run in order, so what is already present is a prefix. The first chunk that
    // does not match is where this run starts, and reading past it would hash gigabytes
    // nobody has written yet.
    if (digest !== chunk.sha256) break

    done += 1
    log(`Chunk ${chunk.i + 1}/${manifest.chunks.length} already restored, skipping.`)
  }

  return done
}
```

Replace lines 132–193 — from `const handle = await fs.open(partial, 'w+')` down
to the `} finally { await handle.close() }` that closes it — with:

```js
    let handle
    let resuming = true

    // r+ keeps whatever an earlier run left behind; w+ truncates it to zero, which is what
    // made a kept .partial useless. Only ENOENT means "no file yet" — a permission error
    // quietly becoming "start over" is how two hours of downloading disappear unexplained.
    try {
      handle = await fs.open(partial, 'r+')
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      handle = await fs.open(partial, 'w+')
      resuming = false
    }

    try {
      // Extends a short .partial with zeros and cuts an over-long one, and touches no byte
      // below manifest.size — so one path serves a fresh file and a resumed one alike.
      await handle.truncate(manifest.size)

      let done = 0

      if (resuming) {
        // Hashing 1800MB takes about 9 seconds, so a large scan runs for minutes. Silence
        // that long is the hang this project refuses everywhere: the heading lands before
        // the first read and a line per chunk arrives as the scan advances.
        log(`Checking what is already in ${partial}...`)
        done = await scanPartial(handle, manifest, log)
        if (done === 0) log(`Nothing in ${partial} matches this backup, starting over.`)
        log('')
      }

      const pending = manifest.chunks.slice(done)

      // A .partial holding every chunk is what a run that died between its last chunk and
      // the rename leaves: no bar at all, rather than one springing into existence at 100%.
      if (pending.length > 0) {
        const present = manifest.chunks
          .slice(0, done)
          .reduce((sum, chunk) => sum + chunk.size, 0)

        // One bar for the whole restore. The label names the chunk in flight, but the bar, the
        // byte counts, the speed and the ETA all describe the file, so the line runs 0% to 100%
        // once instead of restarting at every chunk boundary — with 1800MB chunks, a per-chunk
        // ETA answers a question nobody asked. Chunks an earlier run left count towards the bar
        // but not towards the speed, so an hour-old chunk cannot inflate the ETA of the rest.
        // warn is already the no-op when silent, and createProgress draws through nothing else.
        const progress = createProgress({
          total: manifest.size,
          done: present,
          label: `Chunk ${pending[0].i + 1}/${manifest.chunks.length}`,
          write: warn,
        })

        try {
          for (const chunk of pending) {
            // Before getMessage, not after: the bar is then on screen from the first moment,
            // and finish() below always has a line to close.
            progress.setLabel(`Chunk ${chunk.i + 1}/${manifest.chunks.length}`)

            const message = await getMessage(client, chat, chunk.msgId)

            if (!message) {
              throw new Error(
                `Missing chunk ${chunk.i + 1}/${manifest.chunks.length}: message ${chunk.msgId} is no longer in ${chat}. ` +
                  'This backup cannot be restored.',
              )
            }

            const { sha256, size } = await downloadChunk(
              client,
              message,
              handle,
              chunk.i * manifest.chunkSize,
              progress.advance,
              {
                retryOptions: { ...retryOptions, onRetry },
                concurrency: settings.downloadConcurrency,
              },
            )

            if (size !== chunk.size) {
              throw new Error(
                `Chunk ${chunk.i + 1} has ${size} bytes, the manifest records ${chunk.size} bytes — mismatch.`,
              )
            }

            if (sha256 !== chunk.sha256) {
              throw new Error(
                `Chunk ${chunk.i + 1} has a sha256 that does not match the manifest. The download is kept at ${partial} for inspection.`,
              )
            }
          }
        } finally {
          // The bar owns a line that \r keeps returning to. Ending it here rather than after the
          // loop means a chunk that fails mid-download still leaves the cursor on a fresh line,
          // so "Error: ..." does not land on top of the bar.
          progress.finish()
        }
      }
    } finally {
      await handle.close()
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -12`
Expected: PASS, all tests, no failures.

- [ ] **Step 6: Record the rule where a later session will find it**

Append to `docs/design/data-integrity.md`:

```markdown
- A resumed `runRestore` decides what is already in `<target>.partial` by hashing each
  chunk-sized region against the manifest, in order, stopping at the first that does not
  match — never by reading a record. A record makes claims about a local file anyone can
  edit between runs, and a claim that is wrong means those chunks are never hashed, the
  final length check still passes (the file is truncated to `manifest.size` either way),
  and telstore renames a corrupt file into place. Re-reading also costs a thirty-fourth of
  re-downloading, so the cheap way and the safe way are the same way. Every chunk in a
  finished file was hashed against the manifest by the run that renamed it.
```

Add a row to the table in `CLAUDE.md`, under the first one:

```markdown
| `src/commands/restore.js`, the resume scan | `docs/design/data-integrity.md` |
```

- [ ] **Step 7: Commit**

```bash
git add src/downloader.js src/commands/restore.js test/restore.test.js docs/design/data-integrity.md CLAUDE.md
git commit -m "feat: an interrupted restore carries on from its .partial file"
```

---

### Task 2: A restore record namespace in the state directory

**Files:**
- Modify: `src/state.js`
- Test: `test/state.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces, all from `src/state.js`:
  - `restoreKey(backupId: string, absTarget: string): string` — 40 hex characters
  - `restoreFile(key: string, configDir?: string): string`
  - `loadRestore(key, configDir?): Promise<object|null>`
  - `saveRestore(key, record: object, configDir?): Promise<void>`
  - `clearRestore(key, configDir?): Promise<void>`
  - `listRestores(configDir?): Promise<Array<{ key, record, mtimeMs }>>`
  - `pruneRestores(configDir?, keep?): Promise<void>`
  - `MAX_RESTORES: 20`
  - `listStates` now returns `Array<{ key, state, mtimeMs }>` — `mtimeMs` is new.

- [ ] **Step 1: Write the failing tests**

Add to `test/state.test.js`, and extend its import list with `restoreKey`,
`loadRestore`, `saveRestore`, `clearRestore`, `listRestores`, `pruneRestores`,
`MAX_RESTORES`, `restoreFile`.

```js
function sampleRestore(overrides = {}) {
  return {
    v: 1,
    id: 'telstore-20260901-7c1b40',
    target: '/home/ai/out.tar',
    chat: '@my_backups',
    size: 1000,
    chunks: 3,
    done: 1,
    ...overrides,
  }
}

test('restoreKey is stable and does not collide with an upload key', async () => {
  const a = restoreKey('telstore-20260901-7c1b40', '/home/ai/out.tar')
  const b = restoreKey('telstore-20260901-7c1b40', '/home/ai/out.tar')

  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{40}$/)
  assert.notEqual(a, restoreKey('telstore-20260901-7c1b40', '/home/ai/other.tar'))
})

test('a restore record round-trips, and a missing one reads as null', async () => {
  const configDir = await tempDir('state')
  const key = restoreKey('telstore-20260901-7c1b40', '/home/ai/out.tar')

  assert.equal(await loadRestore(key, configDir), null)

  await saveRestore(key, sampleRestore(), configDir)

  assert.deepEqual(await loadRestore(key, configDir), sampleRestore())
})

test('clearRestore removes the record and ignores one that is not there', async () => {
  const configDir = await tempDir('state')
  const key = restoreKey('telstore-20260901-7c1b40', '/home/ai/out.tar')

  await saveRestore(key, sampleRestore(), configDir)
  await clearRestore(key, configDir)
  await clearRestore(key, configDir)

  assert.equal(await loadRestore(key, configDir), null)
})

test('the two record kinds are invisible to each other', async () => {
  const configDir = await tempDir('state')

  await saveState(stateKey('/home/ai/data.tar', 100, 1757000000000), sampleState(), configDir)
  await saveRestore(restoreKey('telstore-20260901-7c1b40', '/home/ai/out.tar'), sampleRestore(), configDir)

  const uploads = await listStates(configDir)
  const restores = await listRestores(configDir)

  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].state.path, '/home/ai/data.tar')
  assert.equal(restores.length, 1)
  assert.equal(restores[0].record.target, '/home/ai/out.tar')
})

test('a restore record is skipped when it cannot say what it is about', async () => {
  const configDir = await tempDir('state')
  const key = restoreKey('telstore-20260901-7c1b40', '/home/ai/out.tar')

  await saveRestore(key, { v: 1, done: 2 }, configDir)

  assert.deepEqual(await listRestores(configDir), [])
})

test('pruning uploads never evicts a restore, and the reverse', async () => {
  const configDir = await tempDir('state')

  for (let i = 0; i < MAX_STATES + 3; i += 1) {
    await saveState(stateKey(`/home/ai/f${i}.tar`, i, i), sampleState({ id: `up-${i}` }), configDir)
  }

  for (let i = 0; i < 4; i += 1) {
    await saveRestore(restoreKey(`telstore-r${i}`, `/home/ai/o${i}.tar`), sampleRestore({ id: `re-${i}` }), configDir)
  }

  await pruneStates(configDir)

  assert.equal((await listStates(configDir)).length, MAX_STATES)
  assert.equal((await listRestores(configDir)).length, 4)

  for (let i = 0; i < MAX_RESTORES + 2; i += 1) {
    await saveRestore(restoreKey(`telstore-x${i}`, `/home/ai/x${i}.tar`), sampleRestore({ id: `x-${i}` }), configDir)
  }

  await pruneRestores(configDir)

  assert.equal((await listRestores(configDir)).length, MAX_RESTORES)
  assert.equal((await listStates(configDir)).length, MAX_STATES)
})

test('listStates reports when each record last made progress', async () => {
  const configDir = await tempDir('state')
  const key = stateKey('/home/ai/data.tar', 100, 1757000000000)

  await saveState(key, sampleState(), configDir)

  const [entry] = await listStates(configDir)

  assert.equal(typeof entry.mtimeMs, 'number')
  assert.ok(entry.mtimeMs > 0)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL with `restoreKey is not a function` (or an import error naming
the missing exports).

- [ ] **Step 3: Implement in `src/state.js`**

Add the prefix and the shared file helpers just below `stateFile`:

```js
// A restore's record is filed beside the uploads and must never compete with them for a
// prune slot. Losing an upload record strands chunks in a chat where only the id can still
// find them, which is why pruneStates reads each file back to name what it drops; losing a
// restore record costs one line of `status` for a .partial that still resumes perfectly.
// The name is what keeps them apart — an upload key is 40 hex characters and `r` is not
// hex, so the two namespaces cannot collide.
const RESTORE_PREFIX = 'restore-'

// stateKey's trick does not transfer: a .partial changes size and mtime on every write, so
// there is nothing there to key on. What holds still across runs is the backup being
// restored and the path being written.
export function restoreKey(backupId, absTarget) {
  return createHash('sha1').update(`${backupId}:${absTarget}`).digest('hex')
}

export function restoreFile(key, configDir = defaultConfigDir()) {
  return path.join(stateDir(configDir), `${RESTORE_PREFIX}${key}.json`)
}

// One reader for both kinds. A listing that forgets to filter hands `status` a restore
// record as though it were an upload, canResume stats a path that is not in it, and the
// report comes out wrong without anything failing — so there is one place that filters.
async function recordNames(configDir, restores) {
  let names
  try {
    names = await fs.readdir(stateDir(configDir))
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }

  return names.filter(
    (name) => name.endsWith('.json') && name.startsWith(RESTORE_PREFIX) === restores,
  )
}

function keyOfName(name) {
  const base = name.slice(0, -'.json'.length)

  return base.startsWith(RESTORE_PREFIX) ? base.slice(RESTORE_PREFIX.length) : base
}

// Why loadState returns null rather than throwing, in one place both kinds can use: one
// corrupt file must not hide the other records still waiting to be finished.
async function readRecord(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    if (err instanceof SyntaxError) return null
    throw err
  }
}

async function removeRecord(file) {
  try {
    await fs.unlink(file)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}
```

Rewrite `loadState` and `clearState` to go through those:

```js
export async function loadState(key, configDir = defaultConfigDir()) {
  return await readRecord(stateFile(key, configDir))
}
```

```js
export async function clearState(key, configDir = defaultConfigDir()) {
  await removeRecord(stateFile(key, configDir))
}
```

Add the restore trio beside them:

```js
export async function loadRestore(key, configDir = defaultConfigDir()) {
  return await readRecord(restoreFile(key, configDir))
}

export async function saveRestore(key, record, configDir = defaultConfigDir()) {
  await writeJsonAtomic(restoreFile(key, configDir), record)
}

export async function clearRestore(key, configDir = defaultConfigDir()) {
  await removeRecord(restoreFile(key, configDir))
}
```

Replace the body of `pruneStates` so it only sees upload records, and give
`listStates` the mtime the report now sorts on:

```js
export async function pruneStates(configDir = defaultConfigDir(), keep = MAX_STATES) {
  const files = []

  for (const name of await recordNames(configDir, false)) {
    const file = path.join(stateDir(configDir), name)

    try {
      const stat = await fs.stat(file)
      files.push({ key: keyOfName(name), file, mtimeMs: stat.mtimeMs })
    } catch (err) {
      // Gone between readdir and stat: nothing left to prune.
      if (err.code !== 'ENOENT') throw err
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const dropped = []

  for (const { key, file } of files.slice(keep)) {
    // Read before unlink: a file that cannot be read back, or that carries no id, is
    // still pruned — it just cannot be named, and a report naming nothing helps no one.
    const state = await loadState(key, configDir)
    await fs.unlink(file)
    if (state?.id) dropped.push(state)
  }

  return dropped
}

// status needs every unfinished backup at once. A state file that cannot be read is skipped
// rather than fatal, for the same reason loadState returns null: one corrupt file must not
// hide the other backups still waiting to be finished.
//
// The key comes back alongside each record because canResume needs it, and the file name is
// the only place it survives: the record's own path, size and mtime are exactly what a
// rewritten file makes stale, so recomputing the key from them would always say yes. The
// mtime comes back because it is when this backup last made progress, which is the order
// status prints records in.
export async function listStates(configDir = defaultConfigDir()) {
  const states = []

  for (const name of await recordNames(configDir, false)) {
    const key = keyOfName(name)
    const state = await loadState(key, configDir)

    if (!state) continue

    try {
      const { mtimeMs } = await fs.stat(path.join(stateDir(configDir), name))
      states.push({ key, state, mtimeMs })
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  return states
}
```

Rewrite `findStates` to use the same filtered listing — replace its `readdir`
block and loop with:

```js
export async function findStates(backupId, configDir = defaultConfigDir()) {
  const found = []

  for (const name of await recordNames(configDir, false)) {
    const key = keyOfName(name)
    const state = await loadState(key, configDir)

    if (state?.id === backupId) found.push({ key, file: stateFile(key, configDir), state })
  }

  return found
}
```

Add the restore listing and prune at the end of the file:

```js
export const MAX_RESTORES = 20

// A record with no id or no target can neither be printed nor resumed from, so status has
// nothing to do with it. Skipped rather than rendered with blanks: these files are
// hand-editable, and a row that names nothing is worse than no row.
export async function listRestores(configDir = defaultConfigDir()) {
  const restores = []

  for (const name of await recordNames(configDir, true)) {
    const key = keyOfName(name)
    const record = await loadRestore(key, configDir)

    if (typeof record?.id !== 'string' || typeof record?.target !== 'string') continue

    try {
      const { mtimeMs } = await fs.stat(path.join(stateDir(configDir), name))
      restores.push({ key, record, mtimeMs })
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  return restores
}

// Unlike pruneStates this returns nothing and reads nothing back. Dropping a restore record
// strands no data — the .partial it points at still resumes, because the evidence for a
// resume was never in the record — so there is nothing to announce and no reason to open
// each file just to name it. It removes the signpost, never the .partial: a multi-gigabyte
// file must not disappear as a side effect of starting an unrelated restore.
export async function pruneRestores(configDir = defaultConfigDir(), keep = MAX_RESTORES) {
  const files = []

  for (const name of await recordNames(configDir, true)) {
    const file = path.join(stateDir(configDir), name)

    try {
      const stat = await fs.stat(file)
      files.push({ file, mtimeMs: stat.mtimeMs })
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  for (const { file } of files.slice(keep)) await removeRecord(file)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -12`
Expected: PASS. `test/status.test.js` must still pass — `listStates` gained a
field but kept `key` and `state`.

- [ ] **Step 5: Commit**

```bash
git add src/state.js test/state.test.js
git commit -m "feat: a restore record namespace that shares the state directory but not its prune queue"
```

---

### Task 3: Write the record from `runRestore`

**Files:**
- Modify: `src/commands/restore.js`
- Test: `test/restore.test.js`

**Interfaces:**
- Consumes: `restoreKey`, `saveRestore`, `clearRestore`, `pruneRestores` from
  Task 2.
- Produces: a record at `restoreFile(restoreKey(backupId, target))` while a
  restore is unfinished, removed once it finishes. Task 4 reads it.

- [ ] **Step 1: Write the failing tests**

Add to `test/restore.test.js`, extending its imports:

```js
import { restoreFile, restoreKey } from '../src/state.js'
```

```js
test('the record tracks an unfinished restore and is gone once it finishes', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const key = restoreKey(backup.id, out)
  const seen = []

  const base = deps(fakeClient(backup), configDir)

  await runRestore(backup.id, { out }, {
    ...base,
    downloadChunk: async (...args) => {
      seen.push(JSON.parse(await fs.readFile(restoreFile(key, configDir), 'utf8')))
      return await base.downloadChunk(...args)
    },
  })

  assert.equal(seen.length, 3)
  assert.deepEqual(seen.map((record) => record.done), [0, 1, 2])
  assert.equal(seen[0].id, backup.id)
  assert.equal(seen[0].target, out)
  assert.equal(seen[0].chat, '@store')
  assert.equal(seen[0].size, 1000)
  assert.equal(seen[0].chunks, 3)

  await assert.rejects(() => fs.stat(restoreFile(key, configDir)), { code: 'ENOENT' })
})

test('a resumed restore records the chunks it found rather than starting the count over', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const key = restoreKey(backup.id, out)

  const partial = Buffer.alloc(1000)
  backup.content.copy(partial, 0, 0, 800)
  await fs.writeFile(`${out}.partial`, partial)

  const base = deps(fakeClient(backup), configDir)
  let first = null

  await runRestore(backup.id, { out }, {
    ...base,
    downloadChunk: async (...args) => {
      first ??= JSON.parse(await fs.readFile(restoreFile(key, configDir), 'utf8'))
      return await base.downloadChunk(...args)
    },
  })

  assert.equal(first.done, 2)
})

test('a record that cannot be written does not fail the restore', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  // A file where the state directory belongs: every write under it fails, whoever is
  // running the tests. The restore is still a restore.
  await fs.writeFile(path.join(configDir, 'state'), 'not a directory')

  const warnings = collect()

  const result = await runRestore(backup.id, { out }, {
    ...deps(fakeClient(backup), configDir),
    silent: false,
    log: () => {},
    writeErr: warnings.log,
  })

  assert.equal(result.size, 1000)
  assert.deepEqual(await fs.readFile(out), backup.content)
  assert.match(warnings.text(), /could not record restore progress/)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — no record file exists, so the `readFile` inside the fake
`downloadChunk` throws ENOENT.

- [ ] **Step 3: Implement**

Add to the imports in `src/commands/restore.js`:

```js
import { clearRestore, pruneRestores, restoreKey, saveRestore } from '../state.js'
```

Inside `runRestore`, after `const partial = \`${target}.partial\`` (line 113),
add:

```js
    const key = restoreKey(backupId, target)

    // The record is a signpost for `status`, never evidence. The scan above proved every
    // chunk it skipped against the manifest and would do so again if this file vanished, so
    // a signpost that cannot be planted warns and gets out of the way. Deliberately the
    // opposite of markChunkDone, where a failed write must be fatal because losing it
    // strands chunks in a chat with nothing left pointing at them.
    async function note(done) {
      try {
        await saveRestore(
          key,
          {
            v: 1,
            id: manifest.id,
            target,
            chat: String(chat),
            size: manifest.size,
            chunks: manifest.chunks.length,
            done,
          },
          configDir,
        )
      } catch (err) {
        warn(`\nWarning: could not record restore progress: ${err.message}\n`)
      }
    }
```

In the block added by Task 1, right after the `resuming` scan and before
`const pending = ...`, add:

```js
      await note(done)

      // Housekeeping, the way runUpload prunes its own records. It removes signposts only:
      // dropping one costs a line of `status` for a .partial that still resumes.
      try {
        await pruneRestores(configDir)
      } catch (err) {
        warn(`\nWarning: could not tidy old restore records: ${err.message}\n`)
      }
```

Inside the chunk loop, after the `sha256` check passes, add:

```js
            await note(chunk.i + 1)
```

After `await fs.rename(partial, target)`, add:

```js
    // The restore is finished; the signpost has nothing left to point at.
    try {
      await clearRestore(key, configDir)
    } catch (err) {
      warn(`\nWarning: could not remove the restore record: ${err.message}\n`)
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -12`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/restore.js test/restore.test.js
git commit -m "feat: record an unfinished restore so status can find it"
```

---

### Task 4: `status` lists unfinished restores

**Files:**
- Modify: `src/commands/status.js`
- Test: `test/status.test.js`

**Interfaces:**
- Consumes: `listRestores` from Task 2 and the record shape from Task 3.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the failing tests**

Add to `test/status.test.js`, extending its imports:

```js
import { restoreKey, saveRestore, saveState, stateKey } from '../src/state.js'
```

```js
async function savedRestore(configDir, overrides = {}) {
  const record = {
    v: 1,
    id: 'telstore-20260901-7c1b40',
    target: '/home/ai/out.tar',
    chat: '@my_backups',
    size: 1000,
    chunks: 7,
    done: 4,
    ...overrides,
  }

  await saveRestore(restoreKey(record.id, record.target), record, configDir)

  return record
}

test('status names an unfinished restore and how to carry it on', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)

  const dir = await tempDir('status-target')
  const target = path.join(dir, 'out.tar')
  await fs.writeFile(`${target}.partial`, 'x')
  await savedRestore(configDir, { target })

  const out = collect()
  await runStatus({}, {
    configDir, log: out.log,
    connect: async () => fakeClient(), disconnect: async () => {},
  })

  const text = out.text()
  assert.match(text, /1 restore/)
  assert.match(text, /4 of 7 restored/)
  assert.match(text, new RegExp(`npx telstore restore telstore-20260901-7c1b40 --out ${target}`))
  assert.doesNotMatch(text, /--chat/)
})

test('a restore whose chunks are in another chat is resumed with --chat', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@somewhere_else' } }, configDir)

  const dir = await tempDir('status-target')
  const target = path.join(dir, 'out.tar')
  await fs.writeFile(`${target}.partial`, 'x')
  await savedRestore(configDir, { target })

  const out = collect()
  await runStatus({}, {
    configDir, log: out.log,
    connect: async () => fakeClient(), disconnect: async () => {},
  })

  assert.match(out.text(), /--chat @my_backups/)
})

test('a restore whose .partial is gone says so instead of offering a command', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)

  const dir = await tempDir('status-target')
  await savedRestore(configDir, { target: path.join(dir, 'out.tar') })

  const out = collect()
  await runStatus({}, {
    configDir, log: out.log,
    connect: async () => fakeClient(), disconnect: async () => {},
  })

  const text = out.text()
  assert.match(text, /not possible: the partial download is no longer there/)
  assert.doesNotMatch(text, /npx telstore restore/)
})

test('uploads and restores are counted separately in one line', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)

  await saveState(stateKey('/home/ai/data.tar', 100, 1757000000000), {
    id: 'telstore-20260905-7f3a91', chat: '@my_backups', path: '/home/ai/data.tar',
    size: 100, mtimeMs: 1757000000000, chunkSize: 40, done: {},
  }, configDir)

  const dir = await tempDir('status-target')
  const target = path.join(dir, 'out.tar')
  await fs.writeFile(`${target}.partial`, 'x')
  await savedRestore(configDir, { target })

  const out = collect()
  await runStatus({}, {
    configDir, log: out.log,
    connect: async () => fakeClient(), disconnect: async () => {},
  })

  assert.match(out.text(), /Unfinished\s+1 upload, 1 restore/)
})

test('a restore record that will not parse does not take the report down', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)

  await savedRestore(configDir)
  await fs.writeFile(
    path.join(configDir, 'state', 'restore-deadbeef.json'),
    '{ not json',
  )

  const out = collect()
  await runStatus({}, {
    configDir, log: out.log,
    connect: async () => fakeClient(), disconnect: async () => {},
  })

  assert.match(out.text(), /Sho \(@shovity\)/)
  assert.match(out.text(), /1 restore/)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — status prints `1 backup` and no restore block.

- [ ] **Step 3: Implement in `src/commands/status.js`**

Add to the imports:

```js
import { promises as fs } from 'node:fs'
```

```js
import { canResume, listRestores, listStates } from '../state.js'
```

Add beside `resumeCommand`:

```js
// The record holds an absolute target, and printing it is what makes the pasted line
// correct. Without --out, runRestore resolves the manifest's own name against the current
// directory — a name status does not have (it is in a manifest on Telegram, and status
// reaches Telegram only for the account line, where it deliberately tolerates failure) and
// a directory status cannot assume. A command pasted from elsewhere would resolve to
// another path, miss the .partial and start over, which is the failure resume exists to end.
function restoreCommand(record, destination) {
  const matches = destination !== null && record.chat === String(destination)
  const chat = matches ? '' : ` --chat ${shellArg(record.chat)}`

  return `npx telstore restore ${shellArg(record.id)} --out ${shellArg(record.target)}${chat}`
}

// The .partial is the whole reason a resume is possible, so its absence is the one thing
// worth checking before offering a command that would silently start over.
async function restoreResumeLine(record, destination) {
  try {
    await fs.stat(`${record.target}.partial`)
  } catch {
    return field('Resume', 'not possible: the partial download is no longer there.')
  }

  return field('Resume', restoreCommand(record, destination))
}

// Only the kinds actually present are named. "N backups" fits an upload and not a restore:
// there the backup is finished and sitting in the chat, and it is the restore that stopped.
function unfinishedCount(uploads, restores) {
  const parts = []

  if (uploads > 0) parts.push(`${uploads} upload${uploads === 1 ? '' : 's'}`)
  if (restores > 0) parts.push(`${restores} restore${restores === 1 ? '' : 's'}`)

  return parts.length === 0 ? 'none' : parts.join(', ')
}
```

Replace everything from `const states = await listStates(configDir)` to the end
of `runStatus` with:

```js
  const uploads = await listStates(configDir)
  const restores = await listRestores(configDir)

  log(row('Unfinished', unfinishedCount(uploads.length, restores.length)))

  if (uploads.length === 0 && restores.length === 0) return

  // The destination is what decides whether a resume command needs a --chat. A row that
  // failed to parse leaves nothing to compare against, which is not the same as a match.
  const destination = settings?.chat ?? null

  // Newest first, by when the record last changed — which is when that transfer last made
  // progress, and the same ordering pruneStates already means by "recent".
  const entries = [
    ...uploads.map((entry) => ({ ...entry, kind: 'upload' })),
    ...restores.map((entry) => ({ ...entry, kind: 'restore' })),
  ].sort((a, b) => b.mtimeMs - a.mtimeMs)

  for (const entry of entries) {
    log('')

    if (entry.kind === 'restore') {
      const { record } = entry

      log(`  ${record.id}`)
      log(field('File', `${record.target}  (${formatBytes(record.size ?? 0)})`))
      log(field('Chunks', `${record.done ?? 0} of ${record.chunks ?? '?'} restored`))
      log(field('Chat', describeChat(record.chat)))
      log(await restoreResumeLine(record, destination))
      continue
    }

    const { key, state } = entry
    const total = countChunks(state.size, state.chunkSize)
    const done = Object.keys(state.done ?? {}).length

    log(`  ${state.id}`)
    log(field('File', `${state.path}  (${formatBytes(state.size)})`))
    log(field('Chunks', `${done} of ${total} uploaded`))
    log(field('Chat', describeChat(state.chat)))

    for (const line of await resumeLines(key, state, destination, done)) log(line)
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -12`
Expected: PASS. Existing status tests that matched `/none/i` still pass —
`unfinishedCount(0, 0)` is `none`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/status.js test/status.test.js
git commit -m "feat: status lists unfinished restores beside unfinished uploads"
```

---

### Task 5: Tell the truth on Ctrl-C

**Files:**
- Modify: `src/cli.js:123-125`
- Modify: `src/commands/restore.js`
- Modify: `bin/telstore.js:17-29`, and the `restore` switch arm
- Modify: `docs/design/batches.md`
- Test: `test/cli.test.js`, `test/restores.test.js`

**Interfaces:**
- Consumes: the `.partial` retention from Task 1.
- Produces: `runRestore` accepts an `onBackupId(id: string)` dep; `runRestores`
  accepts an `onRestoreDone({ id: string, path: string })` dep.

- [ ] **Step 1: Write the failing tests**

Add to `test/cli.test.js`:

```js
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
```

Add to `test/restores.test.js`, which has its own `fakeChat`, `deps` and
`workspace` helpers — use those, not the ones in `test/restore.test.js`:

```js
test('a batch reports each id as it finishes', async () => {
  const chat = fakeChat(['a.tar', 'b.tar'])
  const { dir, configDir } = await workspace()
  const cwd = process.cwd()
  const finished = []

  // No --out in a batch: each file is named by its own manifest, in the current directory.
  process.chdir(dir)

  try {
    await runRestores(chat.ids, {}, {
      ...deps(chat, configDir),
      onRestoreDone: (item) => finished.push(item),
    })
  } finally {
    process.chdir(cwd)
  }

  assert.deepEqual(finished.map((item) => item.id), chat.ids)
  assert.deepEqual(finished.map((item) => path.basename(item.path)), ['a.tar', 'b.tar'])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `interruptMessage` still says "Download progress is not saved",
and `onRestoreDone` is never called.

- [ ] **Step 3: Rewrite the restore branch of `interruptMessage`**

In `src/cli.js`, replace lines 123–125:

```js
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

    const backup = backupId ? `Backup ${backupId}` : 'This restore'

    return (
      `\n${backup} kept its .partial file — run the same command again from this directory ` +
      'to carry on, or "npx telstore status" to see what is left.\n'
    )
  }
```

- [ ] **Step 4: Add the two deps**

In `src/commands/restore.js`, add `onBackupId = () => {}` to the `runRestore`
deps destructuring, and call it as the first statement of the function body,
before `loadConfig`:

```js
  // The id is on the command line, so Ctrl-C can name this restore from the first moment.
  onBackupId(backupId)
```

In `runRestores`, add `onRestoreDone = () => {}` to its deps destructuring and
call it where a result is recorded:

```js
      try {
        const { path: target, size } = await runRestore(backupId, options, perId)
        results.push({ id: backupId, path: target, size })
        onRestoreDone({ id: backupId, path: target })
      } catch (err) {
```

`runRestores` passes `deps` straight through as `perId`, so `onBackupId` reaches
`runRestore` unchanged.

- [ ] **Step 5: Wire `bin/telstore.js`**

Rename the array and widen its comment (lines 17–19):

```js
// A batch clears each finished item's record as it goes, so by the time Ctrl-C lands these
// are transfers no second run should touch. Ctrl-C needs their names to say so.
const finished = []
```

Update the SIGINT handler's argument at line 27:

```js
    interruptMessage(currentCommand, { backupId: currentBackupId, done: finished }),
```

Update the `upload` arm's callback to push onto `finished`:

```js
        onFileDone: (file) => {
          if (file.id) finished.push(file)
        },
```

Replace the `runRestores` call in the `restore` arm:

```js
      const { failed } = await runRestores(parsed.args, parsed.options, {
        onBackupId: (id) => {
          currentBackupId = id
        },
        onRestoreDone: (item) => {
          finished.push(item)
        },
      })
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -12`
Expected: PASS.

- [ ] **Step 7: Record the batch reasoning**

Append to `docs/design/batches.md`:

```markdown
- Ctrl-C mid-batch says the same thing for restores as for uploads, for a different reason:
  the ids that finished have been renamed to their real names and their records removed, so
  repeating the whole command line meets an overwrite prompt and then downloads them again
  from nothing. The ids that did not finish kept their `.partial` files and carry on where
  they stopped, which is why the message asks for those and not for the whole line.
```

- [ ] **Step 8: Commit**

```bash
git add src/cli.js src/commands/restore.js bin/telstore.js test/cli.test.js test/restores.test.js docs/design/batches.md
git commit -m "fix: Ctrl-C during a restore no longer claims progress is lost"
```

---

## Verification

- [ ] `npm test` — all tests pass, no failures. This is the whole gate.
- [ ] The spec's last requirement — a resumed restore is byte-identical to one
      done in a single run — is carried by the
      `assert.deepEqual(await fs.readFile(out), backup.content)` closing every
      resume test in Task 1. `backup.content` is the original file, so each
      resumed path is measured against the real bytes rather than against
      another run of the same code.
- [ ] `node bin/telstore.js --help` still prints in about 0.06s, and
      `test/bin.test.js` still counts zero executed teleproto scripts.
- [ ] Manual: interrupt a real restore with Ctrl-C, read the message, run the
      command it suggests, and confirm the scan lines name the chunks already
      there and the finished file is correct.
