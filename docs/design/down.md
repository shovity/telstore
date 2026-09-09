# `down`

`logout` taken all the way: the whole config directory, not just the session. `delete`
destroys data on Telegram; `down` destroys data on this machine. Both follow the same rule —
nothing removed that was not asked for, nothing reported gone that is still there.

- **It opens no socket, and that is the feature.** The machine somebody is wiping is often
  one they are handing back, and sometimes one they no longer trust; it may have no network
  at all. So `down` imports `config.js`, `state.js`, `chat.js`, `shell.js` and nothing else.
  `status.js` is the tempting import — it already knows how to describe this directory and
  how to write a resume line — and it statically imports `client.js`. `unfinishedCount` is
  copied rather than borrowed for exactly that reason, and `test/bin.test.js` counts executed
  teleproto scripts on a `down` run to keep it copied.
- **A corrupt config must not be able to stop it.** `loadConfig` throws on unreadable JSON, on
  a `settings` that is not a group, and on a config holding both a sealed session and a plain
  one — and its own advice for all three is *"delete the file and log in again"*. `down` is
  what does that, so it reads the config inside a try and prints "cannot be read — it goes
  anyway" rather than dying on the file it exists to remove.
- **The whole directory goes; every foreign file in it is named first.** `down` removes a
  directory, not a curated list, and pretending otherwise would be the lie. The `Also there`
  row is how delete's rule survives a recursive remove: what goes unnamed is what nobody
  thinks to look for.
- **The two kinds of record do not cost the same, and the output must not say they do.** An
  upload record is what lets a second run keep the same `backupId` and skip the chunks
  already sent; losing it means the same file goes up again as a new backup while the old
  chunks sit in the chat under an id nothing on this machine remembers. So the ids are
  printed before the question. A restore record costs nothing — `pruneRestores` already
  records why: the evidence for a resume was never in the record, it is in the `.partial`.
- **A record made from a command's output is printed as a `delete` command before it goes.**
  The bullet above is about a loss that can be repaired by uploading the file again; this one
  cannot be. A stream record cannot be carried on by any second run — those bytes came from a
  command's stdout, they have gone past, and a later run cuts them differently — and once the
  record is removed **nothing on this machine lists those message ids and no manifest in the
  chat names them.** They are findable by nothing. So `down` prints
  `npx telstore delete <id> --chat <chat>` for each of them, above the question, as the last
  thing anything anywhere will say about those chunks. The chat is named for the reason `status`
  names it: `delete` resolves its own destination from config, and a command pasted next week
  without one would fire those ids at whatever chat is configured by then. A record that cannot
  say where its chunks went gets a line explaining that instead of a command that would guess.
  Printing removes nothing and opens no socket, which is what `test/bin.test.js` holds by
  counting executed teleproto scripts on a `down` run over a directory that really has a stream
  record in it — the earlier count only ever exercised the empty-home path.
- **The `.partial` stays, and its note is not delete's note.** After a `delete` nothing can
  finish it, because the chunks are gone. After a `down` the chunks and the manifest are
  untouched, so the same file still resumes; saying otherwise would send somebody to delete
  gigabytes they could have used. The resume command is printed because this is the last time
  anything will mention that file — the record that listed it in `status` goes with the rest.
- **The summary prints even under `--yes`.** `delete` hides its listing behind the question
  because building it costs Telegram round-trips; here it costs a `readdir`, and under `--yes`
  it is the only record of what went.
- **`down` refuses a positional argument.** `telstore down telstore-20260905-7f3a91` is the
  plausible typo — somebody reaching for `delete` — and obeying it would wipe the machine.
  It also refuses a `configDir` that is a home directory or a filesystem root: no correct call
  can produce one, an empty `HOME` can, and a recursive remove is the one mistake here that
  could not be apologised for.
- **What `down` keeps that `logout` also keeps: nothing.** `logout` deliberately leaves
  `api_id` and `api_hash` behind so the next login is cheap. `down` takes them, and says so,
  because a reader who knows what `logout` does would otherwise assume they were kept.
