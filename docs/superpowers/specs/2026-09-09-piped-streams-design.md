# Piped sources and sinks: `telstore <name> -- <command>`

Status: approved design, half built. The upload direction — `telstore <name> -- <command>` —
is implemented as described here. The restore direction — `telstore restore <id> -- <command>`
— is not: the parser keeps the shape, and telstore **refuses that line** with what to do
today rather than restoring to a file and saying nothing about the command it was handed.

## The problem

telstore uploads a file that already exists on disk. Everything about the upload path
leans on that: `statSource` reads a size and an mtime, `stateKey` hashes
`path:size:mtime`, `planChunks` cuts a known length into a known number of chunks, and
`uploadRange` seeks into an fd by offset. The last of those is what makes a resume
possible, and the re-stat after the final chunk is what stops a manifest describing a
file that changed underneath it.

Two things this shuts out:

- **A directory.** `tar` first, which needs free disk space for the whole archive. A 200GB
  home directory needs 200GB free before a single byte reaches Telegram.
- **Anything generated rather than stored.** `pg_dump`, `mongodump`, `docker save`,
  `zfs send`. All of them write to stdout, none of them leave a file to point telstore at.

Compression and client-side encryption fall out of the same gap: `tar c ./dir | age -r ...`
is a stream, and telstore cannot take one.

## Scope

No new subcommand. `--` on a line telstore already understands means "the rest is a command
of mine, run it and use its stdio as the transfer":

```
telstore <name> -- <command> [args...]        # child stdout  -> Telegram
telstore restore <id> -- <command> [args...]  # Telegram      -> child stdin
```

`telstore <name>` keeps meaning "make a backup called this". Only where the bytes come from
changes, and `--` is what says so.

**Non-goals:**

- Reading a bare pipe (`tar c ./dir | telstore`). Rejected on purpose, see "Why a child
  process" below.
- Resuming either direction. A stream cannot be re-read; see "What is not promised".
- Built-in compression or encryption. `-- sh -c 'tar c ./dir | age -r ...'` covers it
  without telstore holding anyone's passphrase.
- Recording the command in the manifest. `-- pg_dump 'postgres://user:pw@host/db'` would
  put a password in a Telegram message forever.

## Why a child process rather than a pipe

The upload path's one silent-corruption guard is the re-stat: a file that changed during
the upload means the manifest describes a hybrid that never existed, and telstore refuses
to send it. A stream has no equivalent — but it has a failure the file path does not.

When `tar` dies halfway, it closes its end of the pipe. The reader sees EOF, and an EOF
after a crash is byte-for-byte the same event as an EOF after success. `tar`'s exit code
goes to the shell, not to the reader, and by the time the shell knows, the manifest is
already in the chat. The result restores cleanly, matches every sha256, and is a truncated
archive. That is exactly the failure this project exists not to have.

A parent process sees the exit code. So telstore runs the command:

```
manifest is sent  <=>  child stdout reached EOF  AND  child exited 0
```

That biconditional is what replaces the re-stat, and it is the whole reason the bytes come
from a command telstore spawns instead of from stdin.

## CLI surface

```bash
npx telstore a.tar -- tar cf - ./a
npx telstore db.sql -- pg_dump mydb
npx telstore dir.tar.age -- sh -c 'tar c ./dir | age -r age1abc...'

npx telstore restore telstore-20260909-7f3a91 -- tar x -C ./target
npx telstore restore telstore-20260909-7f3a91 -- psql mydb
```

Rules, all enforced in `route`:

- `--` separates telstore's arguments from the child's. Everything after it is argv for the
  child and is never parsed as a telstore flag, so `tar xzf -` and `psql -d db` pass
  through intact. `parseArgs` already runs with `tokens: true`, so the terminator's position
  is available.
- **`protectNegativeChatIds` inserts a `--` of its own** (`src/cli.js`) to rescue
  `config chat -100123` from `parseArgs`. `route` must therefore decide stream mode from the
  argv it was handed, before that rescue runs — otherwise a negative chat id turns into a
  command to execute. This is the one place in the parser where two features write the same
  token for opposite reasons, and a test must hold them apart.
- A name is required **before** `--`. `telstore -- tar cf - ./a` is refused by name rather than
  taking `tar` as the file name and running `cf ./a`, which fails as "cf: not found" and
  sends nobody anywhere useful.
- Exactly one name before `--`. `telstore a.tar b.tar -- tar c ./x` is refused: one child
  process produces one stream, and there is nothing to give the second name.
- At least one word after `--`, or the command is refused.
- The name is a name, not a path telstore reads. If a file of that name happens to exist,
  telstore says so on stderr in one line — the backup's contents come from the command —
  and carries on. Refusing would break the ordinary case of running the same line twice in
  a directory where an earlier restore left the file.
- `restore <id> -- <cmd>` takes exactly one id, for the same reason `--out` does: one child
  process cannot receive two files.
- `--out` together with `--` is refused rather than one silently winning.
- No shell. The child is spawned with an argv, so nothing needs quoting and telstore never
  builds a command string. A user who wants a pipeline writes `-- sh -c '...'` and owns
  that decision.
- `--chat`, `--chunk-size`, `--note`, `--upload-concurrency`, `--download-concurrency` and
  `--verbose` apply as they do today. `--yes` is irrelevant: neither form asks anything.

## Upload: the data path

```
child stdout --> ~/.telstore/tmp/<id>-<i>.chunk --> uploadRange(fd, 0, len) --> sendChunk
```

1. Spawn with `stdio: ['ignore', 'pipe', 'inherit']`. The child's stderr goes straight to
   telstore's, so `tar` complains where `tar` normally complains.
2. Read stdout into a temp file until it holds `chunkSize` bytes or stdout ends.
3. **Pause the stream**, upload the temp file through the existing `uploadRange` (offset 0,
   length = bytes written), `sendChunk` it, record the message id, unlink the temp file,
   resume the stream. Pausing is not an optimisation: without it the child keeps producing
   while a 1800MB chunk uploads for three minutes, and the backlog is memory.
4. Repeat until stdout ends.
5. Send the manifest only if the child also exited 0.

Temp files live in `~/.telstore/tmp/`, not `os.tmpdir()`. On many Linux distributions
`/tmp` is tmpfs, and "borrow one chunk of disk" would silently mean "borrow 1800MB of RAM".
Being under `~/.telstore` also means `down` already removes them.

Peak extra disk is one chunk. Peak extra memory is one part.

**Differences from the file path, all forced by not knowing the length up front:**

- No `planChunks`. Chunks are cut as the bytes arrive; the count is known only at the end.
- `MAX_CHUNKS` is enforced as the run goes rather than before it starts. Hitting it aborts
  and rolls back, naming `--chunk-size` as the way out.
- The progress bar has no total, so no percentage and no ETA: bytes read, bytes sent,
  current chunk, speed.
- Zero bytes of output with a clean exit is refused. A backup of nothing is not a backup,
  and `tar` writing nothing usually means the arguments were wrong.
- The manifest gets `size` = total bytes read and `name` = the name given. No new field, so
  `MANIFEST_VERSION` stays 1 and an older telstore restores these backups perfectly.
- **Chunk captions lose their total.** `chunkCaption` writes `\u{1F4E6} <id> \u00b7 3/12`, and a stream
  does not know the 12 until the last chunk. Stream chunks are captioned `\u{1F4E6} <id> \u00b7 3`
  instead. Nothing parses a chunk caption \u2014 `list` reads the manifest's card and `restore`
  reads the manifest \u2014 so this changes only what a person scrolling the chat sees, and the
  manifest card still carries the final count.

## Upload: what happens when it goes wrong

Every failure rolls back — the chunks already in the chat are deleted, because nothing can
ever point at them again. This is the opposite of the file path, where the chunks are kept
precisely so a second run can resume onto them.

Rollback triggers:

- child exits non-zero, or dies on a signal
- child cannot be spawned (ENOENT: "no such command")
- stdout ends with zero bytes
- `MAX_CHUNKS` reached
- upload fails after retries, or Telegram refuses
- Ctrl-C

Rollback is `deleteMessages` from `src/client.js`, the same call `delete` makes, over the
message ids recorded so far. Then the local record is cleared.

**If the rollback itself fails** (the network is what broke), the record stays on disk,
`status` reports it as leftover chunks rather than as something resumable, and the run
prints `npx telstore delete <id>`. That command already works for a backup with no manifest:
`runDelete` falls back to the local record through `findStates` and `stateMessageIds`
(`src/commands/delete.js`), which is exactly this situation.

**Ctrl-C has to change.** `bin/telstore.js` currently prints a line and calls
`process.exit(130)` immediately. A streaming upload needs to kill the child, delete what it
sent, and only then exit. So:

- a command may register an abort handler through `deps`; SIGINT runs it and waits
- a second Ctrl-C exits at once, printing the id and the `delete` command to run by hand
- `interruptMessage` learns that an upload has two shapes. The file branch says progress is
  saved and to run the same command again; the stream branch must say the opposite —
  nothing is resumable, the chunks are being removed, and here is what to run if this run
  cannot finish removing them.

## Restore into a command: the data path

```
downloadToFile --> ~/.telstore/tmp/<id>-<i>.chunk --> verify sha256 --> child stdin
```

Per chunk: download to a temp file, check its size and sha256 against the manifest, and
only then write it into the child's stdin, honouring backpressure. Nothing unverified
reaches the child — the same rule `runRestore` keeps by hashing before it renames.

- Spawn with `stdio: ['pipe', 'inherit', 'inherit']`.
- After the last chunk, end the child's stdin and wait. A non-zero exit fails the restore,
  even though every byte was correct: `tar x` that ran out of disk did not restore anything,
  and telstore must not report success on its behalf.
- A child that dies early makes the write fail with EPIPE. That is a failure, reported as
  one, with a non-zero exit code.
- No `.partial`, no restore record, no resume — a child's stdin cannot be rewound. `status`
  shows nothing for these runs, and Ctrl-C says so plainly.
- Verification is per chunk; there is no final whole-file check, because there is no file.
  The sum of verified chunk lengths is checked against `manifest.size` instead.

## State record

Stream uploads need a record for one reason only: to know what to delete if the run fails.
It shares `~/.telstore/state/` and the existing prune queue.

- `stateKey` cannot be used — there is no path, size or mtime. Stream records are keyed on
  the backup id.
- The record carries `kind: 'stream'` alongside the existing fields, and `done` keeps the
  same `{ msgId, size, sha256 }` shape, so `stateMessageIds` in `delete` reads it unchanged.
- `canResume` must answer "no" for a stream record without stat-ing a path that is not
  there, and `status` must render it as leftover chunks with a `delete` command rather than
  as an unfinished upload with a resume command. A stream record presented as resumable is
  a lie the file path's wording would tell for us.

## Module boundaries

- `src/uploader.js` and `src/downloader.js` are untouched. They already take an fd, and a
  temp file is an fd.
- Spawning lives behind a `deps` seam (`spawn`), like `connect` and `sendChunk`, so tests
  drive a fake child rather than the real `tar`.
- The chunk-cutting loop for streams is new; it belongs beside the upload command, not in
  `chunking.js`, which is about arithmetic on known sizes and stays pure.

## What is not promised

Said in the help text and the README, not only here:

- **No resume in either direction.** Bytes that went past cannot be read again.
- **Nothing is verified about the source beyond the exit code.** A command that exits 0
  having written the wrong thing is a backup of the wrong thing.
- **The child's stderr is not captured**, so a failure explains itself in the child's own
  words, and telstore adds the exit code and what it did about it.

## Testing

Unit tests (`npm test`, fake client, fake spawn):

- child exits non-zero after N chunks -> no manifest sent, exactly those N message ids
  deleted, record cleared, non-zero exit
- child exits 0 -> manifest sent with the byte count actually read
- zero-byte output -> refused, nothing sent
- rollback that itself fails -> record kept, `delete` command printed
- `MAX_CHUNKS` exceeded mid-run -> rollback, message names `--chunk-size`
- backpressure: the stream is paused while a chunk uploads
- restore into a command: a chunk whose sha256 does not match is never written to the child
- restore into a command: child exits non-zero after consuming everything -> restore fails
- child dies early -> EPIPE surfaces as a failure, not as a completed restore
- `route`: name before `--`, missing name, two names, empty command, `--out` with `--`,
  two ids with `--`, and `config chat -100123` still reaching `config` rather than being
  read as a command to run

E2E (the `e2e` skill, against a real account — not optional before release):

- a real `tar` of a directory larger than one chunk, restored with `-- tar x`, compared
  byte for byte against the original tree
- a deliberately failing producer (`sh -c 'echo hi; exit 1'`) -> chat is empty afterwards,
  which is the assertion no fake client can make
- Ctrl-C mid-upload -> chunks removed from the real chat

The fake client cannot see whether a rollback actually removed anything from Telegram, and
that is the single most important claim this feature makes.
`docs/design/testing-blind-spots.md` is the reason this is written down rather than assumed.

## Docs to update on implementation

- `README.md`: both directions, and a "Limits worth knowing" note that a stream cannot be
  resumed
- `src/cli.js` HELP
- `docs/design/batches.md`: why a stream upload has no batch
- `docs/design/data-integrity.md`: the exit-code biconditional as the stream's re-stat
- `docs/design/module-boundaries.md`: the spawn seam
- a new `docs/design/streams.md` if the reasoning outgrows those rows

## Open risks

- `~/.telstore` may sit on a partition too small for one chunk. No flag for it in this
  version; the failure is a clear ENOSPC naming the temp directory and suggesting a smaller
  `--chunk-size`.
- Killing a child that ignores SIGTERM: SIGKILL after a short grace period, and say so.
- A child that never writes and never exits looks exactly like a stalled network. The
  existing stall timer covers the network side only; a stalled producer is the child's
  problem to report, and telstore stays quiet rather than guessing.
