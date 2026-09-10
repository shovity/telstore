# `telstore tarc` and `telstore tarx`

Two shortcuts for the thing telstore is most often asked to do — put a directory on Telegram
and get it back — and the restore direction of `--` that they need in order to exist.

This spec stands on `2026-09-09-piped-streams-design.md`. That one built
`telstore <name> -- <command>` and deferred `telstore restore <id> -- <command>` to a second
stage, with its data path already written out under "Restore into a command". Stage 2 is built
here as specified there; this document adds the aliases, and pins down what that section left
open. Where the two disagree, this one is later and wins — there is one such place, named
below.

## The problem

Three separate ones, and the third is why this is worth a spec rather than a commit.

**The `-` is a footgun, and the documentation stepped on it.** `telstore a.tar -- tar cf ./a`
is the canonical example in the README, in `--help`, in two error messages and in a design
doc. It does not work:

```
$ tar cf ./a
tar: Cowardly refusing to create an empty archive   (exit 2)
```

Without `f -`, tar writes the archive to a file called `./a` and telstore gets an empty
stdout. The guarantee held — exit 2 means no manifest and a rollback, so nobody lost data —
but every person who copied that line got a failure instead of a backup. An alias that spells
`f -` once, in one place, is the fix that does not depend on anyone reading carefully.

**The restore direction does not exist.** `bin/telstore.js` refuses
`restore <id> -- <command>` with "not built yet". So a shortcut for extraction cannot be an
alias over something: half of it has to be built first.

**Nobody types the long form twice.** `telstore a.tar.gz -- tar czf - ./a` is four decisions
(name, `c`, `z`, `f -`) to make every time, three of which are always the same.

## Scope

Two new subcommands, plus stage 2 of the earlier spec:

```
telstore tarc <name> <path>...    # tar czf -  <path>...  -> Telegram
telstore tarx <backup-id>         # Telegram -> tar xzf -
telstore restore <id> -- <cmd>    # stage 2: the general form, no longer refused
```

`tarc` and `tarx` are expansions, not implementations. `route` rewrites the line into the
shape that already exists and returns the same `{ command, args, childArgv }` the `--` form
returns. No second upload path, no second rollback, no second guarantee to reason about.

**Non-goals.** Everything the earlier spec ruled out stays ruled out: no bare pipe, no resume
in either direction, nothing about the command recorded in the manifest. On top of those:

- **No other compressor.** `tarc` is gzip. `zstd` and `xz` are reachable through `--`, where
  they were already, and adding `tarcz`/`tarcx` spellings is how a CLI turns into a dialect.
- **No flags of tar's own.** `-C`, `--exclude`, `--one-file-system`, `pipefail` pipelines:
  `--` covers all of it and keeps covering it. `tarc` archives the paths it is given.
- **No guessing the name from the paths.** `telstore tarc ./dir` is refused for a missing
  name rather than inventing `dir.tar.gz`, because the rule that reads one positional as a
  name and two as a name plus a path would make `telstore tarc ./x ./y` archive `./y` under
  the name `./x`. Silently archiving the wrong set of paths is exactly the class of wrong
  this project refuses.

## CLI surface

```
npx telstore tarc <name> <path>...       Archive paths with tar and store the archive
npx telstore tarx <backup-id>            Restore a backup and extract it with tar
```

What they expand to, exactly:

| Typed | Run |
| --- | --- |
| `tarc a.tar.gz ./x ./y` | `telstore a.tar.gz -- tar czf - ./x ./y` |
| `tarc --verbose a.tar.gz ./x` | `telstore a.tar.gz -- tar czvf - ./x` |
| `tarx <id>` | `telstore restore <id> -- tar xzf -` |
| `tarx --verbose <id>` | `telstore restore <id> -- tar xzvf -` |
| `tarx --out ./here <id>` | `telstore restore <id> -- tar xzf - -C ./here` |

**The expanded command is printed to stderr before it runs**, once, on its own line. The
shortcut is then also the documentation: someone who needs `--exclude` tomorrow has already
seen the long form it is a shortcut for. It costs one line and removes the only thing an
alias is usually guilty of, which is hiding what it does.

**`v` rides on telstore's own `--verbose`.** tar's listing goes to stderr, not stdout — the
archive on stdout stays clean, measured — but stderr is where `createStreamProgress` draws
its `\r` line, so the two would overwrite each other. `--verbose` already means "show the
teleproto connection log", which already lands on stderr and already interferes with that
line. So `v` joins a mode that is noisy by request instead of making the default mode noisy,
and the progress line keeps the default to itself. The child's stderr stays inherited, never
captured, for the reason `src/spawn.js` gives: a failing command explains itself in its own
words.

**The name rule.** `tarc` always compresses, so the name must always say so. Checked
case-insensitively, the suffix appended in lower case:

| `<name>` ends with | Stored as |
| --- | --- |
| `.tar.gz` or `.tgz` | unchanged |
| `.tar` | `<name>.gz` |
| anything else | `<name>.tar.gz` |

A changed name is **printed**, because the name is what `list` shows and what `--search`
matches: a name telstore altered without saying so is a name its owner cannot look up.

**Refusals**, each naming what to do instead:

- `tarc` with a name but no paths — nothing to archive.
- `tarc` with no positionals at all — no name, same message as the `--` form gives.
- `tarc <name> <path>... -- <command>` — `tarc` *is* the command; one line cannot hold two.
  Same for `tarx`.
- `tarx` with no id, or with more than one. Each backup is its own archive, and extracting
  several into one working directory in sequence is a question with no obvious answer, so it
  is not answered.
- `tarx` on a backup whose manifest name does not claim gzip (no `.tar.gz`/`.tgz`). Refused
  **after reading the manifest and before downloading a byte**, suggesting
  `restore <id> -- tar xf -`. The name is only a claim — a `.tar.gz` name guarantees nothing
  and `tar` is what finally decides — but checking the claim costs one message read, and not
  checking it costs a gigabyte before `tar` says "not in gzip format".

**The cost of two more reserved words.** `tarc` and `tarx` join `SUBCOMMANDS`, so a file
whose name is exactly `tarc` can no longer be uploaded as the first positional. `list`,
`status`, `down` and eight others already carry that trade, and `./tarc` still works.

All existing flags pass through untouched: `--chat`, `--note`, `--chunk-size`,
`--upload-concurrency`, `--download-concurrency`, `--yes`, `--verbose`.

## Restore into a command: what this spec pins down

The data path is the earlier spec's, unchanged: per chunk, download to
`~/.telstore/tmp/<id>-<i>.chunk`, check size and sha256 against the manifest, and only then
write that file into the child's stdin with backpressure. Nothing unverified reaches the
child. No `.partial`, no restore record, no resume. Verification is per chunk and the sum of
verified chunk lengths is checked against `manifest.size`, because there is no file to stat
at the end.

What that section did not settle:

- **It names `downloadToFile`, and that is the right function** —
  `src/downloader.js` is untouched, it takes an fd, and a temp file is an fd. The
  `downloadChunk` that `src/commands/restore.js:85` calls is a `deps` seam name for a local
  wrapper around `downloadToFile` and `hashRange`, not a module export. `restore-stream`
  gets its own seam of the same shape.
- **The child is spawned before the first download.** A command that cannot start (`ENOENT`)
  then costs nothing; spawning after would pay for a whole chunk first. `exited` rejecting
  or resolving at any point aborts the run rather than finishing a download into a pipe
  nobody is reading.
- **A command that stops reading early is a failure, even at exit 0.** `-- head -c 10` exits
  0 having received 10 bytes of a backup, and reporting that as a restore would be the
  confident wrong answer. The rule is the mirror of the upload side's: the run succeeds only
  if every chunk verified, `manifest.size` bytes went through, stdin closed, and the child
  exited 0.
- **One chunk of temp disk, owned by the run.** Removed on every exit path, including the
  failing ones. `status` deliberately never removes a temp chunk —
  `src/commands/status.js:157`: from outside the owning run, a file being filled right now
  and a file left by a run that died are the same file — so a chunk this run leaks is a file
  nothing on the machine will ever delete. This is why a chunk that fails its sha256 is
  **removed rather than kept for inspection**, which is the opposite of what `runRestore`
  does with its `.partial`: there, keeping it lets the next run resume from it; here there is
  no next run to resume.

`src/commands/restore-stream.js` is new and sits beside `upload-stream.js`. `restore.js` is
not extended with a second mode: its whole shape is a file being assembled at offsets and
renamed into place, and a pipe has neither offsets nor a rename.

## What happens when it goes wrong

Exit `0` when it worked, `1` when it did not, `130` for Ctrl-C — the codes
`bin/telstore.js` already hands out.

| What happens | What telstore does |
| --- | --- |
| The command cannot start | Fails before any download. Nothing was fetched, nothing is in `tmp` |
| The command exits non-zero mid-run | Stops downloading at once, removes the temp chunk, reports the child's exit code and how many bytes it had received |
| The command exits 0 before reading everything | Fails, naming the byte it stopped at and the total it was owed |
| A write to stdin fails with `EPIPE` | The same, by the same words: the command stopped reading |
| A chunk message is gone from the chat | The message `runRestore` already gives. Nothing of that chunk reached the command |
| A chunk's size or sha256 disagrees with the manifest | Stops, removes the temp chunk, names the chunk, says the command received a prefix that was correct but incomplete, and that running again downloads it again |
| Every chunk verified, `manifest.size` bytes through, stdin closed, child exited 0 | Success |
| Ctrl-C, first | Closes stdin, `SIGTERM` if the child has not exited within `CLEANUP_DEADLINE_MS`, removes the temp chunk, and says what matters most: **nothing in the chat changed** |
| Ctrl-C, second | Leaves immediately and names the temp chunk it could not remove, through `dropTempChunk` |

The upload direction needs no new words: `tarc` reaches the same `runStreamUpload`, so the
rollback, the Ctrl-C wording and the manifest-only-after-EOF-and-exit-0 rule are the ones
already shipped and already e2e-tested.

## The broken example

`tar cf ./a` becomes `tar cf - ./a` in every place it appears:
`README.md:19,133`, `src/cli.js:63` (the help text) and `:329`, `:355` (two error messages),
`bin/telstore.js:251` (a comment), `docs/design/data-integrity.md:45`, and the two dated
documents of 2026-09-09 — a command that cannot run is a typo, not a decision being
rewritten. `test/upload-stream.test.js:994` asserts the wrong string today and changes with
the message.

The help text's first stream example becomes `npx telstore tarc a.tar.gz ./a`. The `--` form
stays beside it, with `tar cf - ./a`, because it is what `tarc` cannot do.

## What is not promised

Beyond the earlier spec's list, which still holds in full:

- **`tarx` extracts with tar's own semantics**, which means into the working directory, and
  over files already there. telstore does not guard that; `--out` is how you aim it
  somewhere empty.
- **A `.tar.gz` name proves nothing about the bytes.** It is a claim made at upload time and
  checked as a claim. `tar` is the only thing that knows.
- **gzip is one core.** Measured on this machine (8 cores, warm page cache, 306MB of highly
  compressible text, a burst of about ten seconds — *not* a sustained measurement): `tar czf -`
  read at ~30 MB/s and emitted ~5.4 MB/s at a 5.8x ratio, against a measured Telegram upload
  ceiling of ~9.5 MB/s. End to end that is ~10s against ~32s for the same bytes uncompressed,
  so compression wins roughly 3x where the data compresses, and costs only CPU where it does
  not, because the upload ceiling is the limit again. On a one-core machine, or against data
  that does not compress, `--` and plain `tar cf -` remain the faster line.

## Testing

`npm test` stays the whole gate and stays offline. Mutation testing is the standard for the
new tests: delete a line of the behaviour and the suite must go red.

**`route` expansion.** Every row of the expansion table, asserted against the argv the
equivalent `--` line produces — the test that the alias *is* the long form, not a lookalike.
Every row of the name rule, including a name already correct and a name in capitals. Every
refusal, by message. `--out` becoming `-C`, and `--verbose` becoming `v` while still setting
`options.verbose`.

**`restore-stream` against fakes.** One test per row of the failure table. Two deserve naming
because they are the easy ones to fake into vacuity: the sha256 mismatch must assert that the
child received **nothing of that chunk**, and the early-exit case must assert a non-zero exit
even though the child exited 0.

**What the suite still cannot see.** The fake client accepts any object, so handing teleproto
the wrong one — `walk.manifest` where `walk.manifest.message` was meant, which a real account
caught on the upload side — stays invisible on the restore side too.
`docs/design/testing-blind-spots.md` gets the restore direction written into it.

**e2e, real account, throwaway channel, isolated `HOME`, cleaning up only the ids it
created.** On top of the skill's standing checks:

1. A `tarc` → `tarx` round trip over a directory tree, with `--chunk-size` set so one backup
   has a chunk above the 10MB large-file threshold **and** a remainder below it, exercising
   both upload branches in one run.
2. **Compare the extracted tree, never the archive bytes.** gzip writes an mtime into its
   header, so `tar czf -` over an unchanged tree is not byte-reproducible between runs and an
   archive-to-archive sha256 comparison would fail for a reason that has nothing to do with
   telstore. The assertion is the tree: every file's sha256, the sorted list of paths, and the
   modes, before and after. This trap goes into the e2e skill, because the next person to
   write a compression test will reach for the archive first.
3. A producer that fails — `tarc` over a path that does not exist — must leave the chat
   empty. The rollback is not new, but it has never run through an alias.
4. A consumer that fails — `restore <id> -- false` — must exit non-zero and say the command
   failed, not report a restore.

## Docs to update on implementation

- `README.md` — the shortcuts, and the fixed example.
- `src/cli.js` help text — two usage lines, the name rule, what `--verbose` adds.
- `CLAUDE.md` — a row for `src/commands/restore-stream.js`, pointing at
  `docs/design/data-integrity.md`.
- `docs/design/data-integrity.md` — the restore-direction guarantee and the temp-chunk
  ownership rule.
- `docs/design/module-boundaries.md` — `restore-stream.js` beside `upload-stream.js`, and why
  `restore.js` was not extended.
- `docs/design/settings-and-flags.md` — `--verbose` now reaches the child's argv, and `--out`
  means a directory for `tarx`.
- `docs/design/terminal-prompts.md` — why tar's listing is only allowed into an
  already-noisy mode.
- `docs/design/testing-blind-spots.md` — the restore direction.
- `.claude/skills/e2e/SKILL.md` — the gzip-mtime trap and the `tarc` → `tarx` round trip.

## Open risks

- **`FLOOD_WAIT` landing on a rollback has still never met a real server.** Inherited
  unchanged from the upload work: the run long enough to be rate-limited is exactly the run
  that then has to delete dozens of messages while still limited, and every branch of that
  has only been exercised against a fake that answers instantly.
- **`src/client.js` discards what `deleteMessages` returns.** In a group where the account is
  not an admin the server can decline to delete while telstore reports success. Named in
  `docs/design/data-integrity.md`, not fixed here.
- **The gzip numbers are a ten-second burst**, which is the measurement trap this project has
  already fallen into once for throughput. They are good enough to justify `z` as the default
  and not good enough to quote as the ceiling. A sustained number needs a full 1800MB chunk.
- **tar is not one program.** `czf -`, `xzf -` and `-C` are common to GNU tar, bsdtar and
  BusyBox, which is why the expansion uses nothing else. A machine whose `tar` is something
  stranger will say so in its own words, on its own stderr.

Every tar behaviour this spec relies on was measured, on GNU tar 1.35, 2026-09-10, and not
on any other implementation:

| Probe | Result |
| --- | --- |
| `tar czvf - ./a` | Listing on stderr, archive on stdout, first bytes `1f8b` — stdout is clean |
| `tar xzvf -` | Listing on **stdout**, not stderr — the opposite of `czvf`, because stdout is free once the archive is arriving on stdin instead of leaving on it. Measured 2026-09-10 on the same tar: `--verbose` on the restore direction mixes into telstore's own stdout, not into the progress bar on stderr — see `docs/design/terminal-prompts.md` |
| `tar cf ./a` | exit 2, "Cowardly refusing to create an empty archive" |
| `tar czf - ./a \| tar xzf - -C ./out` | exit 0, tree extracted under `./out` — `-C` after `-f -` is accepted |
| `tar czf - ./missing` | exit 2, "Cannot stat" |
| `tar cf - ./a \| tar xzf -` | "gzip: stdin: not in gzip format", exit 141 — loud, but only after the bytes arrive, which is what the name pre-check is for |
| `tar czf - ./a \| head -c 10` | `head` exits **0** having read 10 bytes: the early-exit failure case is real, not hypothetical |
