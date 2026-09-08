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
