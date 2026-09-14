# Encryption

- **Contents are AES-256-CTR, not an AEAD per chunk, because CTR keeps the length.** GCM over each
  chunk adds a tag and breaks the rule everything else rests on: chunk `i` sits at
  `i * chunkSize`, and every chunk but the last is exactly `chunkSize` (`parseManifest`). It would
  also force the file path to write each encrypted chunk to a temp file first, since
  `uploadRange` reads the source by offset — 1800MB of extra disk per chunk at the default size.
  With CTR, `uploadRange` gets a `transform` hook and nothing about layout, resume or
  `MAX_CHUNKS` changes.
- **CTR is malleable; the manifest is what makes it tamper-evident.** The ciphertext sha256 of
  every chunk is in the GCM additional data of the manifest's seal, so nobody without the key
  can change what a restore expects a chunk to hash to, and the ciphertext check every restore
  already made catches any change to a chunk before a byte is decrypted.
- **The plaintext hash is a second check, sealed.** Redundant cryptographically once the
  ciphertext hash is authenticated; it exists for telstore's own bugs (a wrong counter offset
  decrypts to plausible garbage with every ciphertext hash matching) and it is what the restore
  resume scan compares against, since the `.partial` holds plaintext. Sealed rather than open
  because a plaintext hash in the chat lets anyone confirm the backup is a copy of a file they
  already have.
- **Restore order, every path: ciphertext sha256, then decrypt, then plaintext sha256.** File
  restore decrypts in place in the `.partial`; restore into a command decrypts the temp chunk
  before `writeChunkTo`; join decrypts each buffer as it copies.
- **Keys.** scrypt (the `src/token.js` parameters, pinned to manifest version 2) over a 16-byte
  salt per backup, then HKDF into a chunk key and a manifest key — two keys because GCM is CTR
  inside, and one key for both invites a counter-block collision.
- **Nonces are random per attempt at a chunk, never derived from its index.** A run that dies
  mid-chunk leaves parts on Telegram's servers; a derived nonce would put the next run's attempt
  — different bytes, if the file changed — under the same keystream.
- **Encrypted manifests are version 2; plain ones stay version 1 byte for byte.** An older
  telstore checks `v` and nothing else it does not know. Given `v: 1` plus an `enc` field it would
  download the ciphertext, match every sha256 and the length, rename, and print Done over random
  bytes. An older `delete` still works, through the lenient `parseManifestJson`.
- **The additional data is built from the fields in one fixed order, never by re-serializing the
  parsed object**, whose key order belongs to a file a person can edit. The readable fields —
  name, note, hint — are covered too: not secret, but not to be altered either.
- **The seal proves the hint genuine only after the password opens it; before that the hint is
  as trustworthy as the chat.** And before is exactly when it is printed — `Hint   …` sits above
  the password prompt, before any key exists — so the seal cannot stop a tampered hint from being
  shown. What does: `parseManifest` refuses a hint longer than `MAX_HINT_LENGTH` or carrying a
  control character (telstore never writes either; `parseHint` strips them at upload time), and
  every place a hint reaches a terminal — restore's unlock, a resumed upload's prompt, `verify`'s
  `Lock` line, `list`'s `LOCK` column from the caption — passes it through `terminalSafe`, which
  drops C0 and C1 controls and folds whitespace. The worst a stranger's hint can then do is say
  something unhelpful, so the last refusal after three wrong passwords says that a hint which did
  not help may itself have been altered.
- **Passwords come from a terminal only**, the rule `token` keeps. A resumed upload asks again
  and compares an HMAC check kept in the record; neither the password nor a key touches disk.
- **An unfinished encrypted upload's record is filed under `encryptedStateKey`, not `stateKey`,
  for the reason the manifest went to version 2.** An older telstore finds a resume by
  `stateKey(path, size, mtime)` — which every build computes identically — and never reads `enc`.
  Run without `--encrypt` over an encrypted record it would resume it, send the remaining chunks
  in plain, write a version 1 manifest with no ivs, and a later restore would match every sha256
  and print Done over a file that is half ciphertext. A lookup that misses is the only refusal an
  older build can be made to give. The key is sha1 of `enc:<path>:<size>:<mtime>`, the same
  40-hex shape, so listings, pruning and `status` need nothing new. This build looks under both
  keys: a record under the other one is the encrypt/plain mismatch refusal, and a record whose
  `enc` disagrees with the key it is filed under is refused as damaged in either direction —
  never resumed in plain.
- **A batch with `--encrypt` asks one new password, and its hint, after the confirm — even when
  some of its files resume.** `runUploads` cannot know which files have a record without doing
  `runUpload`'s own lookup a second time, and one question for the batch is the promise. Each
  resumed file then checks that password against the HMAC check in its own record: a file
  started under a different one fails alone, named in the summary, and the others carry on. The
  new hint is not applied to resumed files — their record's hint stays, because it belongs to
  the password the chunks already in the chat were encrypted with.
- **The hint is capped at 100 characters because that is what the caption has left** — measured
  2026-09-14, the worst card without encryption is 899 of 1024.
- **What is not promised:** the name, note, size, chunk count, dates and hint are readable by
  anyone who can read the chat, and a forgotten password is a lost backup.

## Measured

**What encryption costs a restore does not show above Telegram's own variance at 16MB.** Measured
2026-09-14 in the project's throwaway e2e channel: one file of 16,777,993 random bytes (not a
multiple of 512KB), cut at 11,534,336-byte chunks — `LARGE_FILE_THRESHOLD` plus 1MB — so one chunk
above the threshold and a 5,243,657-byte remainder below it, downloaded at the default concurrency
of 8. The same bytes went up twice, once plain and once with `--encrypt`, and each was restored
three times from a fresh process, the two alternated, the password typed ahead so the prompt cost
no human time. Wall time, process start to exit, connect and manifest search included:

| run | plain | encrypted |
| --- | --- | --- |
| 1 | 8.36s | 9.28s |
| 2 | 9.41s | 8.73s |
| 3 | 8.13s | 9.66s |
| mean | 8.63s | 9.22s |

All six matched the source sha256. The gap between the means, 0.59s, is smaller than the spread
inside the plain column alone, 1.28s, so this says the cost is lost in the noise at this size — not
what the cost is. What it is was measured apart from any restore, on the same machine: scrypt took
279–749ms per derivation over three runs (the spread is unexplained), the decryption pass over the
same two chunks 130–244ms, and `decryptInPlace` over a 512MB file 81–115MB/s. Against the ~6MB/s
download that `src/chunking.js` records, that is roughly 16–22s of decryption per default 1800MB
chunk against about 300s of download — a few percent, and paid in series: a chunk is decrypted only
after its ciphertext hash has matched, and the next download waits for it.

The machine: Intel Xeon E5-2690 v2 @ 3.00GHz, 31GB of RAM, Node v22.23.1, Ubuntu 24.04.4 LTS on
Linux 6.8, ext4.

What the measurement could not see. Each restore is about eight seconds of transfer, the burst
length the `e2e` skill says has reported speeds 10–19% off, and three runs a side cannot separate a
7% difference from that. One machine, one account, one chat, one afternoon. The 512MB figure came
from a file that fit in the page cache: `decryptInPlace` reads each chunk back out of the `.partial`
and writes it again, and on a disk slower than the cache a full 1800MB chunk pays that second read
and write in full, which nothing here measured. Nor did this time an encrypted upload, a restore
into a command (`tarx`), or `join` — each was checked for correct bytes in the same run, not for
speed.
