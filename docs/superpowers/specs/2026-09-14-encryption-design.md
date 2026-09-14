# Encryption: `--encrypt`

Opt-in, password-based encryption of a backup's contents before any byte leaves the machine,
with an optional hint stored beside it in plain text. Off unless the flag is passed; a backup
made without it is exactly the backup telstore writes today, down to the bytes of its manifest.

## The problem

**Everything telstore uploads is readable by whoever can read the chat, and by Telegram.** The
README says so in its limits ("Your data is not encrypted"), and the documented way out is a
pipeline — `-- bash -c 'set -o pipefail; tar c ./dir | age -r …'`. That works, and it keeps
working, but it asks every user to pick a tool, manage its keys, remember `pipefail`, and it is
not available at all for the plain file path (`telstore big.iso`), which reads the file by
offset and never runs a command.

**A password is what people will actually use.** Key files get lost with the machine they sat
on; a password is carried in a head. The cost of a password is that it gets forgotten, which is
what the hint is for: a line the user writes at upload time, shown back at restore time, never
encrypted.

## Scope

```
telstore <file>... --encrypt             # file upload, batch included
telstore <name> --encrypt -- <cmd>...    # stream upload
telstore tarc <name> <path>... --encrypt
telstore restore <id>                    # detects an encrypted backup, asks for the password
telstore restore <id> -- <cmd>... / tarx # same
telstore join <manifest.json>            # same, offline
```

Every path that writes or reads chunk bytes supports it. `verify`, `delete`, `list` and
`status` need no password and never ask for one.

**Non-goals.**

- **Hiding metadata.** The file name, note, size, chunk count and creation time stay in plain
  text on the manifest card and in the manifest, so `list` and `list --search` keep working.
  Only the contents are encrypted. This was a deliberate choice, and the README says so.
- **A password from anywhere but a terminal.** No environment variable, no flag value, no
  file. `--encrypt` without a TTY is refused before anything happens, the same rule `token`
  keeps: a password that came from somewhere that kept a copy of it is not one telstore will
  vouch for. Unattended encrypted backups stay on the `--` pipeline with a key-based tool.
- **Recovery.** A forgotten password is a lost backup. There is no escrow, no second key.
- **Changing a backup's password, or encrypting an existing backup.** Restore and upload again.
- **A stored setting.** `--encrypt` is a flag with no setting behind it (see "CLI surface").

## Cryptography

### Why not an AEAD per chunk

The obvious design — AES-GCM over each chunk, tag appended — changes every chunk's length.
That breaks the one arithmetic rule the whole integrity story rests on (`parseManifest`: chunk
`i` sits at `i * chunkSize` and every chunk but the last is exactly `chunkSize`), and it forces
the file path to write each encrypted chunk to a temp file before upload, because `uploadRange`
reads the source by offset. At the default chunk size that is 1800MB of extra disk per chunk
and double the I/O. Segmenting inside a chunk (the `age` STREAM construction) has the same
length problem, plus 512KB part alignment to fight.

### The construction

**Contents: AES-256-CTR, length-preserving.** A chunk's ciphertext is exactly as long as its
plaintext, so chunk sizes, offsets, `planChunks`, `countChunks`, `MAX_CHUNKS`, the restore
resume scan and the stream temp-file layout are all unchanged.

**Integrity: the manifest, sealed with AES-256-GCM.** CTR alone is malleable. It is made
tamper-evident by the manifest: the sha256 of every chunk's *ciphertext* is in the manifest's
GCM additional data, so nobody without the key can change what a restore expects a chunk to
hash to, and any change to a chunk in the chat is caught by the ciphertext sha256 check that
every restore already makes — before a byte is decrypted.

**A second check on the plaintext.** The sha256 of each chunk's *plaintext* is stored inside
the sealed part of the manifest and checked after decryption. With an authenticated ciphertext
hash this is redundant cryptographically; it exists because "never produce wrong data silently"
covers telstore's own bugs too — a wrong counter offset decrypts to plausible garbage with every
ciphertext hash matching. It is also what the restore resume scan compares against, since the
`.partial` holds plaintext. It is sealed rather than plain because a plaintext hash in the open
lets anyone confirm whether a backup is a copy of a file they already have.

### Keys

- `salt`: 16 random bytes per backup.
- `master = scrypt(password.normalize('NFC'), salt, 32, { N: 65536, r: 8, p: 1, maxmem: 128MB })`
  — the parameters `src/token.js` already uses, for the reasons written there. Pinned to
  manifest version 2, never carried in the manifest: a manifest naming its own `N` would let a
  stranger decide how much memory this machine allocates.
- `chunkKey = HKDF-SHA256(master, salt, 'telstore v2 chunk key', 32)`
- `manifestKey = HKDF-SHA256(master, salt, 'telstore v2 manifest key', 32)`

Two keys, because GCM is CTR inside: one key used for both invites a counter block from one
coinciding with a counter block from the other.

### Nonces

Each chunk gets 8 random bytes (`iv`) generated when its upload **starts**, in every run. The
CTR counter block for byte `offset` of chunk `i` is `iv (8 bytes) || uint64_be(floor(offset / 16))`,
with `offset % 16` keystream bytes discarded when the offset is not block-aligned. A chunk is
at most 1950MB, ~1.3 × 10⁸ blocks, far below 2⁶⁴, so the counter never carries into the nonce.

A fresh nonce per attempt rather than one derived from the chunk index is what makes keystream
reuse impossible rather than improbable: a run that dies halfway through uploading chunk 3
leaves parts of it on Telegram's servers, and the next run re-encrypts chunk 3 under a new
nonce. With a derived nonce, a file changed between those runs would put two different
plaintexts under one keystream.

A part that `withRetry` resends is the same buffer, already encrypted, so a retry sends
identical bytes.

### The manifest, version 2

An encrypted backup's manifest is `v: 2`. An unencrypted one stays `v: 1`, byte for byte.

```json
{
  "v": 2,
  "id": "telstore-20260914-ab12cd",
  "name": "photos.tar.gz",
  "size": 3774873600,
  "chunkSize": 1887436800,
  "createdAt": "2026-09-14T08:00:00.000Z",
  "note": "optional, as today",
  "enc": {
    "salt": "<32 hex>",
    "hint": "optional",
    "sealed": "<base64: 12-byte nonce | 16-byte tag | ciphertext>"
  },
  "chunks": [
    { "i": 0, "msgId": 1042, "size": 1887436800, "sha256": "<ciphertext>", "iv": "<16 hex>" }
  ]
}
```

- `sealed` decrypts to `{"plainSha256": ["<hex>", ...]}`, one entry per chunk, in order.
- **The additional data** is built by one function, never by re-serializing the parsed file:
  `JSON.stringify(['telstore-enc-v2', id, name, size, chunkSize, createdAt, note ?? null,
  salt, hint ?? null, chunks.map(c => [c.i, c.msgId, c.size, c.sha256, c.iv])])`. An array in a
  fixed order has one serialization; a re-serialized object depends on key order in a file a
  person can edit. Every field is covered, including the name, note and hint that stay
  readable: they are not secret, but they must not be *altered* — a hint changed by someone
  else is a phishing line printed by telstore.
- **Why the version goes up.** An older telstore checks `v` and nothing else it does not know.
  Given a `v: 1` manifest with an extra `enc` field it would download the ciphertext, match
  every sha256 (they are the ciphertext's), match the length (CTR preserves it), rename, and
  print `Done` over a file of random bytes. `v: 2` makes it stop before the first byte with
  "only understands version 1". `delete` in an older telstore reads manifests through the
  lenient `parseManifestJson` and keeps working on encrypted backups, which is correct: the
  message ids are plain.

`parseManifest` accepts `v: 2` and checks its **structure** without a password — `enc` an
object, `salt` 32 hex characters, `hint` a string or absent, `sealed` a string, every chunk an
`iv` of 16 hex characters — on top of every layout check it makes today. `verify` therefore
works on an encrypted backup without asking for anything. Opening the seal is a separate step
(`openManifest`) that only restore and join take.

A failed GCM tag is one failure with two causes, and telstore names both, likelier first, as
`src/token.js` already does: the password is wrong, or the manifest was altered.

## CLI surface

**`--encrypt`**, boolean, no setting. It joins the list of flags with no setting behind them in
`docs/design/settings-and-flags.md`: stored, it would make every upload for months ask for a
password somebody set once and forgot.

It is accepted by upload only (file, batch, `--`, `tarc`). Anywhere else it is refused with a
sentence saying that restore, `tarx` and `join` detect encryption from the manifest — a flag
silently ignored beside a restore reads as "decrypt with this", which it would not be.

### Upload

Asked after the batch listing and its `[y/N]` (nobody types a password and then cancels),
before the connection, before any state is written:

```
Password: ********
Password again: ********
Hint (optional, shown in the chat as plain text): the cat's name
```

- One `createPrompts` for the whole exchange, as `docs/design/terminal-prompts.md` requires,
  writing to stderr so stdout stays clean.
- Mismatched passwords: an error, run again. Empty password: refused.
- The hint is folded onto one line the way `parseNote` folds a note, capped at 200 characters,
  and refused if it contains the password (case-insensitive) — a hint that *is* the password
  is a plaintext password in the chat.
- No TTY: refused before anything else, naming `--encrypt`.
- A batch asks once. Every file still gets its own salt, so each pays one scrypt (~64MB, a
  fraction of a second).

### Resume

A file upload's state record gains `enc: { salt, check, hint }`, where
`check = HMAC-SHA256(manifestKey, 'telstore v2 password check')`. Neither the password nor a key
is written to disk. Each `done` entry also records `iv` and `plainSha256`.

| unfinished record | this run | result |
| --- | --- | --- |
| encrypted | `--encrypt` | asks for the password once (shows the record's hint, asks no new one); a mismatch is refused, because the chunks already sent were encrypted with the first one |
| encrypted | no `--encrypt` | refused, as a disagreeing `--chunk-size` is: run again with `--encrypt`, or delete the record to start a new backup |
| plain | `--encrypt` | refused, the same way round |

In a batch, a resumed file whose record rejects the password is that file's failure in the
summary; the others carry on.

`status` prints the command that resumes an unfinished backup, and for an encrypted record that
command carries `--encrypt` — otherwise the line telstore prints to be pasted is one it would
then refuse.

### Restore, `tarx`, `join`

After the manifest is parsed and before anything else — the overwrite question, the
`.partial`, spawning the command:

```
Backup telstore-20260914-ab12cd is encrypted.
Hint   the cat's name
Password: ********
```

- The hint shown is the manifest's (authenticated), never the caption's.
- A wrong password is asked again, three attempts in all.
- In a batch restore, passwords that opened an earlier backup in the same run are tried first,
  silently; the prompt appears only when none of them opens this one.
- No TTY: refused, naming the backup, before any chunk is downloaded.
- Ctrl-C at a password prompt leaves at once with the terminal echoing again. Checked under a
  real pty, as `docs/design/terminal-prompts.md` describes.

## Data paths

### New module: `src/cipher.js`

Pure — no teleproto — so `join` can use it without importing the network side.

- `deriveKeys(password, salt)` → `{ chunkKey, manifestKey }`
- `passwordCheck(manifestKey)` → hex
- `chunkCipher(chunkKey, iv)` → `{ apply(bytes, offset) }`, CTR at any offset in the chunk
- `sealManifest(manifest, keys, plainSha256)` / `openManifest(manifest, password)`
- `decryptInPlace(fd, offset, length, cipher)` → plaintext sha256; reads, decrypts and writes
  back in large blocks, hashing the plaintext as it goes

### Upload, file and stream

`uploadRange` gains one optional hook, `transform(bytes, offsetInRange)`, identity by default.
It is called on each part in order, before the part is hashed and sent; the returned buffer is
what is hashed and sent. The upload command's transform hashes the plaintext it is given and
returns the ciphertext, so `uploadRange` still returns the sha256 of the bytes Telegram holds.
`uploader.js` learns nothing about flags, passwords or manifests
(`docs/design/module-boundaries.md`).

The stream path applies the same transform when it uploads each temp chunk file.

### Restore, every direction

One order everywhere: **ciphertext sha256, then decrypt, then plaintext sha256.** Nothing is
used before all three pass.

- **File restore.** `downloadChunk` and its size and sha256 checks are unchanged; then
  `decryptInPlace` over the chunk's range of `.partial`, then the plaintext hash against the
  sealed list. `scanPartial` compares against `plainSha256` for an encrypted backup. A run that
  dies between a chunk's download and its decryption leaves ciphertext in that range, which the
  next scan fails to match and downloads again — safe, and no new state to keep.
- **Restore into a command.** The temp chunk is checked, decrypted in place, checked again, and
  only then handed to `writeChunkTo`. The rule in `docs/design/data-integrity.md` — no byte
  reaches the command before its chunk is verified — now means verified as plaintext.
- **Join.** `copyChunk` hashes the ciphertext as it reads, decrypts the buffer before writing,
  and hashes the plaintext; both must match before the rename. The failure paths are today's.

### Verify, delete

`verify` is unchanged apart from one line in its header, `Encrypted  yes`. `delete` is
unchanged.

### Caption and `list`

- `manifestCaption` adds `🔒 encrypted` and, when there is one, `💡 <hint>`, above the restore
  line. `parseManifestCaption` returns `encrypted` and `hint`; both are optional markers, like
  the note, so every existing card still parses.
- `list` gains a `LOCK` column, shown only when some backup in the table is encrypted (the rule
  the `NOTE` column already follows): `🔒`, or `🔒 <hint>` shortened to 40 characters. Someone
  who forgot a password looks here first.
- `list --search` is unchanged; the hint is not searched.

## What happens when it goes wrong

| failure | when | outcome |
| --- | --- | --- |
| no TTY with `--encrypt` or an encrypted restore | before anything | refused, nothing sent or written |
| passwords differ / empty / hint contains it | before connect | refused |
| wrong password on resume | before any chunk | refused, record kept |
| wrong password on restore, three times | before any download | refused, nothing written |
| GCM tag fails on a right-looking password | before any download | refused: wrong password or altered manifest |
| chunk altered in the chat | after that chunk's download | ciphertext sha256 mismatch, as today |
| plaintext hash mismatch after decryption | after that chunk's decryption | refused as a telstore fault; nothing renamed or handed to a command, and each path keeps or removes its file as it does for a ciphertext mismatch today |
| older telstore restoring a v2 backup | before any download | "only understands version 1" |

## What is not promised

- Metadata privacy: name, note, size, chunk count and dates are visible.
- The hint is plain text in the chat, readable by anyone who can read the chat.
- The password's strength is the user's; telstore refuses only an empty one.
- Resistance to someone with this machine's `~/.telstore` during an unfinished upload: the
  record holds a password check an attacker can brute-force offline at scrypt's cost — the
  same cost the manifest in the chat already offers them.

## Testing

`npm test` cannot see the network, and it cannot see one failure this feature invites more
than any other: **a transform that is never wired in passes every round-trip test**, because
plaintext goes up and plaintext comes back. So:

- **The bytes the fake client receives are asserted to differ from the source**, for the file
  path and the stream path, and to contain no 64-byte run of the plaintext.
- `cipher.test.js`: CTR applied part by part at odd offsets equals a one-shot encryption;
  known-answer vector against Node's own `aes-256-ctr`; changing any one field in the
  additional data fails the tag; a wrong password fails; no `plainSha256` appears in the
  serialized manifest.
- `manifest.test.js`: v2 structure checks; v1 manifests unchanged byte for byte.
- Round trips with the fake client: file, batch, stream, `tarc`/`tarx`, join.
- The resume table above, row by row; three wrong passwords; batch password reuse; no TTY;
  a hint containing the password; `status` printing `--encrypt`.
- The prompt under a real pty: masking, Ctrl-C restoring echo.
- **The `e2e` skill against a real account**, because `uploader.js` changes: an encrypted file
  upload through both the `SaveFilePart` branch (≤10MB) and the `SaveBigFilePart` branch,
  `tarc`/`tarx` encrypted, a restore compared byte for byte, and the time the decryption pass
  adds to a restore **measured**, not estimated, and written into `docs/design/encryption.md`.

## Docs to update on implementation

- New `docs/design/encryption.md`: the construction and why, the version bump, the nonce rule,
  the measurement; plus a row in `CLAUDE.md`'s table for `src/cipher.js` and every file this
  touches.
- `docs/design/data-integrity.md`: v2 and the restore order.
- `docs/design/settings-and-flags.md`: `--encrypt` among the flags with no setting.
- `docs/design/captions.md`: the two new markers and the `LOCK` column.
- `HELP` in `src/cli.js` and the README; the README's "Your data is not encrypted" becomes what
  is and is not encrypted, and says in so many words that a forgotten password is a lost backup.

## Open risks

- **The decryption pass costs a read and a write of every restored byte.** With AES-NI, CTR runs
  at gigabytes per second and the network at ~6MB/s, so it should vanish — but "should" is the
  word this project has been burned by; the e2e run measures it.
- **scrypt in a batch restore** runs once per attempted password per backup. Twenty backups
  under five different passwords is up to a hundred derivations, tens of seconds. Accepted;
  revisit only if someone meets it.
- **Emoji in the `list` table.** `padEnd` counts code units, not columns; `🔒` is two of each
  in common terminals, which happens to line up. A terminal that draws it one column wide will
  misalign the `LOCK` column by one. Cosmetic.
