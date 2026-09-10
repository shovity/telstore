# Module boundaries

- `src/uploader.js` and `src/downloader.js` know byte ranges and Telegram's part APIs; they
  must not mention CLI flags like `--chunk-size` in their errors.
- `src/downloader.js` fetches a chunk as 8MB slices through a pool of concurrent
  `iterDownload` streams — one stream is one request at a time, capping a restore at
  round-trip latency (~3 MB/s). Bytes land out of order, so the chunk's sha256 is taken by
  reading the assembled range back off disk. That check is about assembly, not media: the
  read may be served from the page cache.
- `src/commands/*.js` own the user-facing narrative. `caption.js`, `chat.js`, `chunking.js`,
  `manifest.js`, `progress.js`, `retry.js`, `settings.js`, `stall.js`, `state.js`, `token.js`,
  `session.js`, `config.js` are pure enough to test without a client.
- `connect` in `src/client.js` is the one door a session goes through, which is why opening a
  sealed one lives there and not in eight (soon nine) commands. `src/session.js` holds what
  knows both config shapes — `unlockConfig` and `assertLoggedIn` — so `client.js` stays about
  Telegram; `assertLoggedIn` beside `connect` was why `token` loaded all of teleproto.
- `src/confirm.js` holds the y/N prompt `restore` and `delete` share, and
  `findManifestMessage` lives in `src/client.js` rather than either command — two copies of
  "how telstore finds a manifest" is how they start disagreeing about which file it is.
- **`src/spawn.js` is the seam a stream upload gets its bytes through**, the same shape
  `connect` and `sendChunk` have: an argv in, `{ stdout, stdin, exited, kill }` out, handed to
  `runStreamUpload` through `deps` so the tests drive a fake child instead of the real `tar`.
  Its one real decision is that the child's stderr is **inherited, never captured**: a producer
  that fails explains itself in its own words on the stream the user is already watching, and
  telstore adds the exit code and what it did about it rather than paraphrasing. It also
  attaches a no-op `.catch` to `exited` on the spot, because the caller reads `stdout` first and
  only awaits `exited` at the end — a rejection with no handler yet is an `unhandledRejection`
  that takes the process down before the rollback can run.
- **`src/stream.js` is pure**: `ChunkReader` takes a Readable, and a file handle is what each
  `fill(handle, limit)` writes into — not something the constructor holds. That is what lets one
  reader span a whole run: the stream is the long-lived thing and the chunk file is the
  short-lived one, opened and discarded per chunk. It knows nothing about Telegram, chunks in a
  chat, or a child process, which is why it is tested without either. Pulling through its own async iterator is also what gives backpressure for
  free — while a chunk uploads nothing calls `next()`, so the backlog waits in the pipe and in
  the child rather than in this process's memory, which for a 1800MB chunk is the difference
  between a temp file and an OOM. The chunk-cutting loop that uses it lives beside the upload
  command, not in `chunking.js`: that file is arithmetic on known sizes and stays that way.
- **`src/commands/restore-stream.js` is new, beside `upload-stream.js`, rather than a second
  mode inside `restore.js`.** `restore.js`'s whole shape is a file assembled at offsets and
  renamed into place once every offset is proven: `.partial`, `fs.open(partial, 'r+')`,
  `handle.truncate(manifest.size)`, `scanPartial` hashing a byte range at
  `chunk.i * manifest.chunkSize`, `fs.rename(partial, target)`. A pipe has none of that — no
  offset to seek to, because a command's stdin can only be written in order; no file to rename,
  because there is nothing at the far end telstore can see the inside of. A `stream: true` flag
  threaded through `runRestore` would not skip that machinery, it would replace nearly all of
  it with an if-branch, which is how two unrelated restores end up sharing one function and one
  set of bugs.
- **`writeChunkTo` hand-rolls its write/drain loop instead of using `stream.promises.pipeline`,
  and it is not solving the same problem `ChunkReader` solves.** `ChunkReader` pulls from one
  Readable that spans the whole run and has to stop at a chunk boundary partway through it —
  `pipeline` has no stopping point to give it, so it was never a candidate there. `writeChunkTo`
  moves one whole chunk file, a fully known length, into one destination in a single call,
  which is the shape `pipeline` is for — and it was tried, and it was wrong. `pipeline(source,
  destination, { end: false })` is required because a command's stdin has to survive past the
  end of one chunk to receive the next, but `{ end: false }` is also what stops `pipeline`'s own
  cleanup from ever running: it leaves its `'error'`, `'close'`, `'finish'` and `'end'`
  listeners on the destination for the life of the run — one of each, so four listeners per
  chunk on the destination `writeChunkTo` actually writes to, a child's stdin. (A `PassThrough`,
  which is what the test fixtures use as a destination, only grows one handler per chunk there;
  the count depends on the destination type, not on `pipeline` itself, so a reader who measures
  a `PassThrough` and gets a smaller number has not found a second bug.) Measured on node 22
  against a child's stdin: four listeners added per chunk, `MaxListenersExceededWarning` printed
  over the `\r` progress bar by the eleventh chunk, and at `MAX_CHUNKS = 10_000` about 40,000
  closures sitting on one emitter, each retaining a finished pipeline's graph for as long as the
  process runs. Invisible to `npm test` entirely, because every fixture restores two chunks.

  Replacing `pipeline` meant owning what it did for free, and two things bit before the
  hand-rolled loop was right. First, `write()` on a destination that is already destroyed or
  already ended returns `false` and emits nothing at all — no `'error'`, no `'close'`, no
  `'drain'` — so a naive drain wait that only listens for those events never ends; measured
  four ways (destroyed, destroyed with a pending error, ended before the call, ended during
  it), and `pipeline` had been getting this right by itself — it rejected on all four. That is
  exactly the gap a hand-rolled loop has to close on its own once `pipeline` is gone:
  `writeChunkTo`'s `failureNow()` asks the stream's own `.destroyed`/`.writableEnded` flags
  directly, rather than waiting on an event that may never arrive. Second, an `'error'` on a
  child's stdin with nothing listening for it is an uncaught
  exception that takes the whole process down — `pipeline` had been supplying that listener by
  accident, as part of the cleanup `{ end: false }` then skips — so `restore-stream.js` now
  holds its own latch (`pipeFailure`) for the life of the run instead of relying on a library
  to have been listening on its behalf.
- **`src/tar.js` is two pure string functions with no imports, not a branch inside
  `src/cli.js`'s parser.** `archiveName` and `isGzipName` are needed by two callers that have
  nothing else in common — the parser, before anything is open, to write the stored name;
  `restore-stream.js`, before anything is downloaded, to check a `tarx` target's claim — and a
  function living inside the parser would make the restore command import the parser to reach
  it, or copy it. Pure and import-free is also what lets `cli.test.js` and `tar.test.js` assert
  the naming rule without constructing a parsed command line or touching a file: a gzip suffix
  is a question about a string, answered the same way everywhere it is asked.
- **`src/uploader.js` and `src/downloader.js` were not touched at all, because a temp file is an
  fd.** `uploadRange(client, handle.fd, { offset: 0, length })` neither knows nor cares that the
  bytes arrived through a pipe rather than off a disk, so the stream path costs no second
  uploader, no second retry policy and no second stall deadline — the three places where a
  divergence would be most expensive to find. Anything genuinely shared with the file path
  (`createOnRetry`, `realSendChunk`, `realSendManifest`) is exported from `upload.js` rather
  than copied, but the loop itself is its own file: `upload.js` was already close to 600
  lines, and a second upload loop inside it is how the two paths start disagreeing.
- **The temp chunks live in `~/.telstore/tmp`, not `os.tmpdir()`.** `/tmp` is tmpfs on many
  Linux distributions, so borrowing one chunk of disk there would silently have been borrowing
  1800MB of RAM — a memory limit wearing a chunk size's clothes, discovered by whoever first ran
  the default `--chunk-size` on a machine with 2GB. Being under `~/.telstore` also means `down`
  already removes them and names the directory as telstore's own rather than reporting it as a
  foreign entry someone should look at. `tempDirFor` and `listTempChunks` therefore sit in
  `state.js` beside `stateDir`, not in the upload command: they answer the same question — what
  has this machine got of telstore's on it — and `status` has to be able to ask it without
  importing `upload-stream.js`, which would drag a second upload loop and teleproto behind it.
  **One chunk at a time, measured on the restore direction against a real account** (2026-09-10,
  `tarx` of a 3-chunk 35MB backup cut at 15MB, `~/.telstore/tmp` sampled 60 times at 0.4s):
  never more than one file in the directory and never more than 15,728,640 bytes in it — exactly
  one chunk — with the directory back to empty when the run ended. The upload direction was
  measured the same way on 2026-09-09. Neither measurement went near the 1800MB default, so what
  is confirmed is the *shape* — one chunk borrowed, never two — and not the behaviour of a
  machine whose disk is the size of one.
- `bin/telstore.js` imports each command inside its own `switch` arm. Nine static imports made
  every run pay for teleproto (~0.4s, 50MB) including `--help`, `config`, `logout` and `token`;
  those now start in 0.06s. `src/cli.js` stays static because every run parses arguments.
  Nothing in the suite would notice a static import creeping back, so `test/bin.test.js` runs
  the binary under `NODE_V8_COVERAGE` and counts executed teleproto scripts — must be zero.
