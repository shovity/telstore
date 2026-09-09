# Data integrity

- `parseManifest` validates the chunk *layout*, not just the total size — a correct sum
  with individually wrong chunk sizes yields a file with a hole while every per-chunk
  sha256 still matches.
- `runUpload` re-stats the source after the last chunk and refuses to send the manifest
  if size or mtime moved: a file rewritten mid-upload gives a self-consistent manifest
  for a hybrid that never existed.
- `runRestore` writes `<target>.partial`, verifies every chunk's size and sha256 plus the
  final length, and renames only after all of it passes.
- Manifests and state files are both untrusted input (one from a chat, one from disk a
  truncated write or hand edit can mangle). `parseManifest` and `planChunks` reject
  anything that is not a whole number of bytes rather than doing arithmetic on it: a
  string or null does not throw, it rejects for the wrong reason or spins a loop that
  never advances until memory runs out.
- `~/.telstore/config.json` is hand-editable, so it gets the same treatment: a stored
  value is parsed through the same function as the flag, and a `settings` that is not an
  object is named rather than stepped over — otherwise telstore runs on defaults while
  the user's own choices sit there ignored.
- A `note` is absent from the manifest rather than null when nobody wrote one, so a manifest
  without one is the same file telstore wrote before the flag existed and `MANIFEST_VERSION`
  stays 1 — bumping it would make an older telstore refuse a backup it can restore perfectly.
  `parseManifest` still refuses a `note` that is not text: nothing restores differently because
  of it, but a manifest is a file a person can edit and send back, and a field holding
  something other than what it claims to be is where telstore stops rather than guesses.
- The local record is the only pointer to chunks in the chat, so `runUpload` refuses a
  `--chunk-size` that differs from the unfinished backup's own rather than starting over,
  and `pruneStates` (keeps `MAX_STATES` most recent) names on stderr every id it drops,
  even when the caller asked for silence.
- A resumed `runRestore` decides what is already in `<target>.partial` by hashing each
  chunk-sized region against the manifest, in order, stopping at the first that does not
  match — never by reading a record. A record makes claims about a local file anyone can
  edit between runs, and a claim that is wrong means those chunks are never hashed, the
  final length check still passes (the file is truncated to `manifest.size` either way),
  and telstore renames a corrupt file into place. Re-reading also costs a thirty-fourth of
  re-downloading, so the cheap way and the safe way are the same way. Every chunk in a
  finished file was hashed against the manifest by the run that renamed it.
- `listStates` and `listRestores` stat each record only to learn when it last made progress,
  which is the order `status` prints in — never to decide whether the record exists, since its
  contents have already been read by then. So a failed stat yields an unknown time that sorts
  last rather than a dropped row or a thrown report: the file can vanish between the readdir
  and the stat, and `status` is the command someone runs *because* something is wrong.

- **A stream upload has no re-stat to make, and the child's exit code is what stands in its
  place.** `telstore a.tar -- tar cf ./a` reads a command's stdout, so there is no file to
  stat, no length known up front and no `planChunks`. The rule that replaces it is a
  biconditional, and it is the entire reason telstore spawns the command instead of accepting
  `tar c ./dir | telstore`: **the manifest is sent if and only if stdout reached EOF and the
  child exited 0.** When `tar` dies halfway it closes its end of the pipe, and on the reading
  end an EOF after a crash is byte-for-byte the same event as an EOF after success — the exit
  code goes to the shell, not to the reader, and by the time the shell knows, the manifest is
  already in the chat. What that produces is the failure this project exists not to have: a
  backup that restores cleanly, matches every sha256, and is a truncated archive. A parent
  process sees the exit code, so telstore is the parent. Both halves are enforced, including
  the odd one: a child that exits 0 while the stream itself errored sends no manifest either,
  which is why `ChunkReader` latches a source error instead of asking the iterator again — an
  async generator that has already thrown reports `done: true` on the next call, and left
  unguarded that turns one real failure into a clean end of stream one call later.
- **Every failure of a stream upload removes the chunks it already sent, and that is the
  opposite of what the file path does on purpose.** `runUpload` keeps its chunks because the
  next run resumes onto them — the record is the only pointer to them, which is why the bullet
  above guards it so carefully. A stream cannot be resumed: the bytes have gone past and a
  later run cuts them differently, so a chunk left behind by a failed stream is a chunk no
  manifest will ever name, sitting in somebody's chat under an id nothing prints. Removing them
  is part of failing, not a courtesy. Rollback deletes the ids this process has in hand rather
  than the ones on disk, because a write to disk is one of the things that can have failed; the
  manifest joins that list the moment it is sent, since a rollback that took the chunks and left
  the card would leave a backup `list` advertises and `restore` cannot fulfil. The triggers are
  every way a run can end badly — a non-zero exit or a signal, a command that cannot be spawned,
  zero bytes written with a clean exit (a backup of nothing is not a backup, and it is usually
  wrong arguments), `MAX_CHUNKS` reached (checked as the run goes, because there is no length to
  count from, and the way out is a bigger `--chunk-size` rather than a resume), an upload
  Telegram refused, and Ctrl-C.
- **When the rollback itself fails, the record stays and is said to be the reason.** The network
  is usually what broke, so this is not a rare shape. The record is then the only list of those
  message ids on this machine, `status` reports it as leftover chunks rather than as something
  resumable, and the run prints the `npx telstore delete <id> --chat <chat>` that finishes the
  job — with the chat spelled out, because `runDelete` resolves its own destination from config
  and these ids fired at the wrong peer would destroy whatever happens to carry them there.

- `verify` exists because nothing else answers "is this backup still restorable" without
  downloading it. It asks the chat about every chunk message the manifest names — still
  there, still a document, still the file name telstore wrote, still the length recorded —
  and that is all it can ask: the bytes inside are only proved by fetching them. So the
  closing line says so out loud rather than letting "verified" be read as more than it is.
  The first failing check per chunk wins, because "2 damaged" has to mean two chunks.
- `verify` goes through the full `parseManifest`, not the lenient `parseManifestJson` that
  `delete` takes. The two commands read a manifest for opposite reasons: `delete` reads one
  to destroy what it names, so a manifest failing its layout checks is exactly the broken
  backup somebody is there to remove; `verify` reads one to answer whether `restore` would
  work, and `restore` would refuse this one. Reporting that in `parseManifest`'s own words
  keeps one fault with one description.
- An id `verify` cannot look up does not stop a batch, where the same id would stop a
  `delete` batch before anything was destroyed. Nothing here is destroyed, and the other ids
  are the ones somebody is checking on. Both a damaged backup and an id nothing could be
  found for count as failures, because the exit code answers one question: did the run find
  everything it was asked to check.
