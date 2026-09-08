# Batches

- `runUploads` is what `telstore a b c` runs; `runUpload` is still one file and knows nothing
  about batches. The batch shares one connection by wrapping the `connect`/`disconnect` deps
  rather than opening a client itself, so `runUpload` stays the only caller of `connect`. One
  file short-circuits straight to `runUpload` — same lines, same thrown error, no summary. What
  can be known before the first byte goes out is settled up front (a duplicate name, a missing
  path, no login, no destination): those refuse the whole batch, because a typo in the fourth
  name surfacing an hour into the third file is the same silent waste as `route` dropping the
  argument, which is what this replaced. What only the transfer can discover is per file — it is
  named on stderr the moment it happens, again in the summary, and carried out as exit code 1.
  Ctrl-C mid-batch is the one place the old wording turned into a lie: the finished files have
  had their records cleared, so `interruptMessage` names them and asks for the files that are
  left instead of "the same command again".
- `src/sources.js` turns what was typed into what will be sent: a folder is the files one level
  inside it, a pattern is the names it matches. The shell expands `*` first and that is the
  expansion telstore prefers — this one only runs on a pattern that arrived intact, and follows
  the same rules so a quoted pattern is not a second feature with different answers. One level,
  never a recursive walk: a home directory would become thousands of backups nobody asked for.
  Hidden files are skipped as every shell skips them, subfolders are **named on stderr** rather
  than silently missing from the list, and a folder or pattern that yields nothing is an error —
  "0 files uploaded" is the silence this project does not do.
- A note is parsed before the first byte, in `runUpload` and again in the batch pre-flight: it
  is written into the manifest, which goes out last, so one Telegram would refuse has to stop
  the run at the start rather than after an hour of chunks whose only list can no longer be
  sent — and one bad note is one mistake, not one failed row per file. `--note` is also the one
  flag that invites a shell mistake telstore cannot undo: unquoted, every word after the first
  arrives as another file to upload, so `statSource` says exactly that — under **two**
  conditions, neither sufficient alone. The note must still be one word (one that kept its
  spaces is one the shell was told to keep whole, so this cannot have happened to it), and a
  file must have been named *after* the flag, which is where an unquoted note's tail lands.
  Either test alone talks over a real typo: `--note march not-found.tar` fails the first,
  `--note "ghi chu" not-found.tar` the second. Position is something only `route` can see, so
  it reports `filesAfterNote` and `bin/telstore.js` hands it to `runUploads` through `deps` —
  a wire every other test would stay green with cut, which is why `test/bin.test.js` runs the
  real binary against an unquoted note. What survives both tests is `--note march` written
  *before* the files, and that is the order nobody types.
- More than one file is listed with its sizes and confirmed before the first byte goes out, and
  `--yes` is what a script passes instead. Without a terminal the batch **refuses** rather than
  reading an empty line as "no": a pipe has no answer to give, and "Cancelled on request" would
  name a request nobody made. One file short-circuits past all of it — no list, no question.
- `runRestores`, `runVerifies` and `runDeletes` mirror `runUploads` exactly: one id short-circuits, several
  share one connection through the deps seam, pre-flight refuses what is knowable (a duplicate
  id, `--out` against several ids since it names one file, no login), each failure is named when
  it happens and again in the summary, and `failed > 0` is exit code 1. `runDeletes` is the one
  that looks first: it reads every manifest and record **before** asking, so the single question
  that authorises the whole run can say what all of it is, and an id nothing knows about stops
  the batch before anything is destroyed. A manifest too damaged to parse costs its row a name,
  not the run — that broken backup is exactly what somebody is here to remove. Each `runDelete`
  then runs with `yes: true` and looks its own manifest up again: one extra search and a few KB
  per backup, in exchange for the most dangerous command in the project keeping its own flow.
- Ctrl-C mid-batch says the same thing for restores as for uploads, for a different reason:
  the ids that finished have been renamed to their real names and their records removed, so
  repeating the whole command line meets an overwrite prompt and then downloads them again
  from nothing. The ids that did not finish kept their `.partial` files and carry on where
  they stopped, which is why the message asks for those and not for the whole line.
- `runVerifies` is the one batch with no question in front of it: it removes nothing and
  writes nothing, so there is nothing to authorise. It is also the one where an id nothing
  can be found for is a single failed row rather than a refusal of the whole run — the
  reasoning that makes `runDeletes` stop before it destroys anything has nothing to protect
  here, and the remaining ids are exactly what somebody is checking on.
