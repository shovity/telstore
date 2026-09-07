# Restore resume

Status: approved, not yet implemented
Date: 2026-09-07

## The problem

A restore that is interrupted loses everything it downloaded.

`runRestore` opens `<target>.partial` with `w+`, which truncates it to zero
(`src/commands/restore.js:132`). Nothing records what landed. So a dropped
connection, a killed process, a closed laptop, or a single chunk failing its
sha256 all cost the same thing: the whole download, from chunk 1.

At the 6.0 MB/s a restore sustains (`src/chunking.js`), a 50GB backup takes
about 2.4 hours. Losing it at 90% is the ordinary case this design exists for,
not the exotic one. `src/cli.js:124` currently tells the user so in as many
words: *"Stopped. Download progress is not saved, running again starts over."*

The same gap makes a sha256 mismatch far more expensive than it needs to be.
Today a bad chunk 29 of 30 throws away chunks 1–28 along with it, even though
those 28 were each verified against the manifest on the way in.

## Approach

**The evidence lives in the `.partial` file, not in a record.**

On a rerun, hash each chunk-sized region of the existing `.partial` against the
sha256 the manifest already records for that chunk, in order, and stop at the
first region that does not match. That is where downloading resumes.

A record is written to `~/.telstore/state/` so `status` can list unfinished
restores, but nothing on the resume path reads it. If it is missing, stale, or
hand-edited, the restore still runs and still produces correct bytes.

### Why not trust a record instead

Mirroring `runUpload` exactly — a record listing which chunks landed, trusted on
resume without re-reading — is the obvious design and it is wrong here.

An upload's record makes claims about a **remote** artifact: chunks already sent
to a chat, which nothing local can quietly change. Its key is
`sha1(path:size:mtime)` of the *source* file, so a source that changed since
cannot match the record at all (`src/state.js:12`, `canResume`).

A restore's record would make claims about a **local** file that anyone can
truncate, edit, or replace between runs. That trick does not transfer: the
`.partial` changes size and mtime on every write, so there is nothing stable to
key on. A record that is wrong about which chunks are present means those chunks
are never hashed, the final length check still passes (the file is truncated to
`manifest.size` regardless), and telstore renames a corrupt file into place —
the one outcome this project forbids outright.

Re-reading is also cheap in the only comparison that matters. Measured on the
development machine (Xeon E5-2690 v2, no SHA-NI — the pessimistic case), a
read-and-hash pass runs at ~204 MB/s. Resuming at 90% of a 50GB restore:

| | cost |
|---|---|
| re-hash 45GB locally | ~3.7 min |
| re-download 45GB at 6.0 MB/s | ~2.1 hours |

34x cheaper, and it buys back a guarantee rather than spending one.

### Why not slice-level resume

Resuming at 8MB granularity instead of chunk granularity would lose at most 8MB
rather than at most one chunk. But the manifest carries no per-slice digests, so
there would be nothing to verify a slice against — slice-level resume can only
be built on a record that must be trusted, inheriting the flaw above, at 225
record writes per chunk instead of one.

Worst-case loss at chunk granularity is one 1800MB chunk, about 5 minutes at
6.0 MB/s, against the 2.4 hours being recovered. Not worth a format that has to
be believed.

## The resume path

### Opening

```js
// today: truncates to zero, which is what makes a kept .partial useless
const handle = await fs.open(partial, 'w+')
```

Try `r+` first; fall back to `w+` only when the error is `ENOENT`. Any other
error — a permission problem, `EISDIR` — is fatal. A failure that silently
becomes "start over" is how two hours disappear without an explanation.

`handle.truncate(manifest.size)` stays exactly where it is. It extends a short
`.partial` with zeros and cuts an over-long one, and touches no byte below
`manifest.size`, so one code path serves both a fresh file and a resumed one.

### Scanning

Only when the `.partial` already existed. A fresh restore pays nothing.

For chunk `i` = 0, 1, 2, …:

```
hashRange(fd, i * chunkSize, chunk.size) === chunk.sha256 ?
  match    -> count as done, continue
  mismatch -> stop scanning; downloading starts here
```

Stop at the first mismatch rather than scanning the whole file. Downloads always
run in order, so what is already present is always a prefix, and the scan then
costs in proportion to the progress being recovered — resuming at chunk 2 of 30
hashes two chunks, not thirty.

`hashRange` is currently private to `src/downloader.js:41`. Export it.
`docs/design/module-boundaries.md` already places "read the assembled range back
off disk and hash it" in that module; a second copy in `restore.js` is how two
definitions of the same check start disagreeing.

A region the `truncate` just zero-filled matches only if the real chunk is
genuinely that many zero bytes — in which case the data is correct. No special
case is needed. It is written down because it looks like a hole and is not.

The scan reads through the page cache, the same caveat
`docs/design/module-boundaries.md` already records for the per-chunk check: it
proves the assembly, not that the bytes reached the platter. After a machine
crash the cache is gone and the read is from disk; after a killed process it may
not be. Either is fine — the digest is what is being checked, not the medium.

### Reporting

Hashing a 1800MB chunk takes about 9 seconds, so a 45GB scan is 3.7 minutes.
Silence that long is exactly the hang `docs/design/stalls-and-retries.md` exists
to end. Print a heading before the first read, then one line per verified chunk
in the idiom `runUpload` already uses:

```
Checking what is already in out.tar.partial...
Chunk 1/30 already restored, skipping.
Chunk 2/30 already restored, skipping.
```

The lines arrive ~9s apart and are the progress indication. When nothing matches
at all, say so — `Nothing in out.tar.partial matches this backup, starting
over.` — rather than falling silent after announcing a check.

### Downloading

Skip chunks `0..k-1`, start at `k`. The progress bar is seeded with the bytes
already present, the same shape `runUpload` uses at `src/commands/upload.js:281`.

**Every chunk in the finished file was hashed against the manifest by the
process that renamed it**, including the ones this run did not download. Resume
weakens the existing guarantee by nothing at all. Under a trusted-record design
it would.

## The record

### Where

`~/.telstore/state/`, beside the upload records, distinguished by file name:

```
3f8a1c...9d2b.json           upload (unchanged)
restore-7c1b40...a19f.json   restore
```

They share a directory but must not share a prune queue. Losing an upload record
strands chunks in a chat where only the id can still find them, which is why
`pruneStates` reads each file back to name what it drops (`src/state.js:88`).
Losing a restore record costs one line of `status` output for a `.partial` that
still resumes perfectly. One 20-slot LRU across both lets the harmless eviction
push out the serious one.

So `listStates`, `findStates` and `pruneStates` skip `restore-*`, and
`listRestores`/`pruneRestores` take only those. Upload keys are 40 hex
characters and `r` is not hex, so the two namespaces cannot collide.

### Key

`stateKey(path, size, mtime)` does not transfer: a `.partial` changes size and
mtime on every write. A restore's identity is the pair that does hold still:

```js
restoreKey(backupId, absTarget) = sha1(`${backupId}:${absTarget}`)
```

Hashed rather than named directly after the backup id, for the reason
`safeOutName` exists (`src/commands/restore.js:39`): the id arrives from the
command line, and a hash means the path-traversal question is never asked.

### Contents

Display only, so it holds exactly what `status` prints:

```json
{ "v": 1, "id": "telstore-20260901-7c1b40", "target": "/home/u/out.tar",
  "chat": "@my_backups", "size": 13316505600, "chunks": 7, "done": 4 }
```

`done` is a count, not a list — nothing reads it to make a decision. No
`partial` field (it is `${target}.partial`), no `chunkSize` (unused), no
`updatedAt` (the file's mtime already says, which is what prune sorts on).

`target` is the path that run actually wrote to —
`path.resolve(options.out ?? safeOutName(manifest.name))`, stored verbatim. It
is never a name telstore invents.

### Lifecycle

Written once the scan is done and before the first chunk, so an immediate Ctrl-C
still leaves a signpost. Updated after each chunk lands — one atomic write per
~5 minutes of transfer. Removed after `rename` succeeds. A resumed run recounts
`done` from the `.partial` and overwrites, so a stale record heals itself.

**A record that cannot be written warns once and the restore continues.** This
is what makes "the record has no authority" true rather than merely stated: a
signpost that cannot be planted has no business killing a two-hour download.
Deliberately the opposite of `markChunkDone`, where a failed write must be fatal
because losing it strands chunks. `pruneRestores` failing warns too.

### Prune does not delete `.partial` files

Pruning removes the signpost, never the thing it points at.

`runRestore` calls `pruneRestores` the way `runUpload` calls `pruneStates` — as
housekeeping during an unrelated command. Deleting a `.partial` there would mean
starting one restore silently destroys tens of gigabytes belonging to another,
irreversibly, from a command that never mentioned it. It would also contradict
what telstore itself prints on a digest mismatch: *"The download is kept at …
for inspection"* (`src/commands/restore.js:183`).

Losing a record costs nothing recoverable — rerunning the restore still finds
the `.partial` and still resumes, because the evidence was never in the record.
Orphaned `.partial` files are a real disk cost, and the answer is to make them
visible in `status`, not to remove them behind the user's back. A cleanup
command, if ever wanted, is something a user types.

## `status`

One section, not two. Each block already says which kind it is — the `Chunks`
line reads `uploaded` or `restored`, and the `Resume` line is a different
command — so a separate heading would only add a distinction the reader has
already made.

```
Unfinished   1 upload, 1 restore

  telstore-20260906-9f2a11
  File    /home/u/big.tar  (50.0 GB)
  Chunks  4 of 29 uploaded
  Chat    @my_backups
  Resume  npx telstore /home/u/big.tar

  telstore-20260901-7c1b40
  File    /home/u/out.tar  (12.4 GB)
  Chunks  4 of 7 restored
  Chat    @my_backups
  Resume  npx telstore restore telstore-20260901-7c1b40 --out /home/u/out.tar
```

Blocks are ordered by file mtime, newest first — the same notion of recent that
prune sorts on. Note this is a change for uploads too: `listStates` returns
whatever order `readdir` gave (`src/state.js:120`) and only `pruneStates` sorts
today. A merged list has to be ordered by something, and "most recently made
progress" is the ordering the directory already means.

The count line names only the kinds present: `1 upload`, `2 restores`,
`2 uploads, 1 restore`, and `none` when there are neither. This replaces the
current `N backup(s)` wording, which a restore does not fit — the backup is
finished and sitting in the chat; it is the restore that is unfinished.

A restore record that will not parse is skipped, and one that parses but is
missing a field it needs is rendered with what it has. `status` is what someone
runs *because* something is wrong, and one hand-edited file must not take the
account line and the other backups down with it — the same rule `loadState`
already follows by returning null (`src/state.js:19`) and `accountLine` follows
by catching its own failures.

The resume command always carries `--out`. Without it, `runRestore` resolves the
target from the manifest's own name against the current directory
(`src/commands/restore.js:112`), and `status` knows neither: the name is in a
manifest on Telegram, and `status` reaches Telegram only for the account line,
where it deliberately tolerates failure. Even knowing the name, a command pasted
from a different directory would resolve elsewhere, miss the `.partial`, and
restart from zero — the exact failure this feature exists to prevent. The record
holds an absolute `target`, so printing it makes the pasted line correct from
anywhere. `--chat` is added when the record's chat differs from the destination
in force, reusing `shellArg` and the rule already at `src/commands/status.js:36`.

A `.partial` that the user deleted by hand leaves an orphaned record:
`status` stats it and prints `Resume  not possible: the partial download is no
longer there.`, in the shape of `NO_RESUME` at `src/commands/status.js:47`.
`status` deletes nothing — it has no side effects today and must not grow any.

## Interruption

`interruptMessage`'s restore branch (`src/cli.js:123`) becomes false the moment
this ships and has to change with it.

Batch restore needs the treatment `docs/design/batches.md` already describes for
uploads. Ids that finished have been renamed to their real names and their
records removed, so rerunning the whole command line would meet an overwrite
prompt and then download them again from zero. Name them and ask for the ones
that are left. `bin/telstore.js:19` already keeps `finishedUploads` for exactly
this; it widens to serve both commands, and `currentBackupId` gets set for
restore, where the id is on the command line already.

## Error handling

| Situation | Behaviour |
|---|---|
| `.partial` open fails, not `ENOENT` | fatal |
| read error during the scan | fatal, naming the `.partial` — telstore is about to write gigabytes to that same disk, and hiding a failing one is not on |
| scan matches nothing | one line, then a normal full download |
| record write fails | warn once, continue |
| `pruneRestores` fails | warn once, continue |
| target exists | unchanged prompt, unchanged position — it asks about `out.tar`, not the `.partial`, and running before the scan means "no" costs no reading |
| two processes, same target | races exactly as today; telstore has no locks anywhere and this is not the place to introduce the only one |
| same backup, two `--out` targets | two `.partial` files, two records (the key includes the target), two `status` blocks, no interference |

## Files

| File | Change |
|---|---|
| `src/downloader.js` | export `hashRange` |
| `src/state.js` | `restoreKey`, `saveRestore`, `clearRestore`, `listRestores`, `pruneRestores`, `MAX_RESTORES`; **`listStates`/`findStates`/`pruneStates` skip `restore-*`** |
| `src/commands/restore.js` | open `r+`, scan, skip, write the record |
| `src/commands/status.js` | restores in the `Unfinished` block, mtime order, new not-possible reason |
| `src/cli.js` | `interruptMessage` restore branch, batch variant |
| `bin/telstore.js` | widen `finishedUploads`, set `currentBackupId` for restore |
| `docs/design/data-integrity.md` | the rule that resume re-verifies and the record is never trusted |
| `docs/design/batches.md` | the batch-restore interruption wording |
| `CLAUDE.md` | add `src/commands/restore.js` to the `data-integrity.md` row |

The row most likely to break something quietly is `src/state.js`. A `listStates`
that forgets to filter hands `status` a restore record as though it were an
upload, `canResume` stats a `state.path` that is not there, and the report is
wrong without anything failing.

## Tests

`test/restore.test.js` already has `fakeBackup`, `fakeClient(backup, {
corruptMessageId })` and a `deps()` helper, so most of this extends what is
there rather than building new scaffolding.

1. A `.partial` holding 2 of 3 chunks correctly: only chunk 3 is fetched (count
   the message ids the fake is asked for), output correct.
2. A `.partial` corrupt at chunk 2: chunks 2 **and** 3 are fetched, chunk 1 is
   skipped — proving stop-at-first-mismatch rather than skip-and-continue.
3. A `.partial` shorter than `manifest.size`: padded by `truncate`, resumes at
   the right chunk.
4. A `.partial` matching nothing: full download, output correct.
5. **No `.partial`: no scan at all**, holding the "a fresh restore pays nothing"
   claim.
6. Record written before the first chunk, updated, and removed after `rename`.
7. A record that cannot be written does not fail the restore.
8. `listStates` ignores `restore-*` and `listRestores` ignores upload records;
   the two prune caps are independent.
9. `status` prints a restore block with `--out`; `--chat` only when it differs;
   a missing `.partial` prints the not-possible line; the count line reads
   `2 uploads, 1 restore` and `none`; a restore record that will not parse is
   skipped without taking the report down.
10. `interruptMessage('restore')` says the new thing; the batch variant names
    the finished ids.
11. A resumed restore produces a file byte-identical to one restored in a single
    run.

`test/bin.test.js` counts executed teleproto scripts and must stay at zero.
