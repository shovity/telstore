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
  name, note, hint — are covered too: not secret, but a hint changed by someone else is a line of
  their choosing that telstore prints above a password prompt.
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
- **The hint is capped at 100 characters because that is what the caption has left** — measured
  2026-09-14, the worst card without encryption is 899 of 1024.
- **What is not promised:** the name, note, size, chunk count, dates and hint are readable by
  anyone who can read the chat, and a forgotten password is a lost backup.

## Measured

<!-- Task 13 fills this in from the e2e run: chunk size, restore wall time with and without
     --encrypt, the share the decryption pass took, the machine. -->
