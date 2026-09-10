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
- `bin/telstore.js` imports each command inside its own `switch` arm. Nine static imports made
  every run pay for teleproto (~0.4s, 50MB) including `--help`, `config`, `logout` and `token`;
  those now start in 0.06s. `src/cli.js` stays static because every run parses arguments.
  Nothing in the suite would notice a static import creeping back, so `test/bin.test.js` runs
  the binary under `NODE_V8_COVERAGE` and counts executed teleproto scripts — must be zero.
