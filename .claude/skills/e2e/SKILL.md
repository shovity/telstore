---
name: e2e
description: Test telstore against a real Telegram account. Use before a release, after changing anything that talks to teleproto or the network, or when you need to find out how Telegram actually behaves rather than how a fake client says it does. Covers what must be checked every run, how to isolate the machine's session, how to probe server behaviour without fooling yourself, and how to clean up.
---

# Testing against a real account

## Why this is not a test file

Every test under `test/` talks to a fake client that accepts whatever it is given, so the
suite cannot see a mismatch with teleproto's real API surface. That has shipped a broken
release twice:

- The GramJS move changed `iterDownload` to `(file, params)`. 459 tests stayed green against
  a call the real client refuses outright.
- `test/retry.test.js` built flood errors by hand. Under GramJS every real flood error carried
  the literal `errorMessage` "FLOOD", so `floodWaitSeconds` matched nothing and every
  `FLOOD_WAIT` was retried on the ordinary backoff — asking again inside a running ban, which
  is how a ban gets longer.

Both were invisible to a green suite and obvious within seconds of a real account. This used
to be a fixed file, `e2e/live.test.js`. It is a skill now because the findings that mattered
most did not come from assertions written in advance — they came from probing the server and
building a measurement that could refute what we already believed. A fixed file cannot decide
to do that. You can.

**What you owe in exchange for that freedom:** the checks under "Every run" below are not
optional. They are what the fixed file guaranteed, and nothing else guarantees them now.

## Before you touch anything

Ask the user which chat to use, unless they have already said. **Never use the real backup
chat.** This runs `delete --yes`, and a scoping mistake there destroys real backups. The
project keeps a throwaway channel for exactly this; its id is not in the repo. If there isn't
one, create one (`Api.channels.CreateChannel`, `broadcast: true`).

**Isolate `HOME` before running a single command.** `logout` and `config` write, and a run
against the real `~/.telstore` destroys the session of whoever is running this. `os.homedir()`
follows `$HOME`, so one prefix isolates everything:

```js
const config = await loadConfig()                       // the machine's own login
if (config.sealed) throw new Error('sealed session needs a passphrase; no terminal here')
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'telstore-e2e-'))
await saveConfig(
  { apiId: config.apiId, apiHash: config.apiHash, session: config.session, settings: { chat: CHAT } },
  path.join(home, '.telstore'),
)
// then run every command with env { ...process.env, HOME: home }
```

Drive `bin/telstore.js` as a subprocess. Testing the binary is the point — importing the
command functions skips argument parsing, lazy imports and exit codes.

## Every run

Miss one of these and the run has not replaced what it was meant to replace.

1. **Round trip, byte for byte, twice — once on each side of the big-file threshold.**
   Telegram splits its upload API at 10MB (`LARGE_FILE_THRESHOLD`), and the branch is chosen
   per chunk, not per file: at or below is `SaveFilePart`/`InputFile`, above is
   `SaveBigFilePart`/`InputFileBig`. Derive both sizes from the threshold itself so they
   cannot drift away from it. Give the big case a chunk above the threshold **and a remainder
   below it**, so one upload crosses the branch both ways. Compare sha256 of the restored file
   against the source. That comparison is the only assertion that truly matters — everything
   else exists to fail earlier and more clearly.

2. **Random, incompressible bytes, written a megabyte at a time.** Never hold the whole file
   in memory.

3. **`verify` must catch a chunk that is gone.** Read the manifest, delete one chunk message
   behind telstore's back, and check `verify` exits non-zero and names the chunk. Telegram
   answers about a deleted message with `MessageEmpty` rather than omitting it — no fake
   client can be trusted to imitate that, and reading it as "chunk still present" is exactly
   the silent wrong answer `verify` exists to prevent. Then delete the backup and check
   `verify` reports the backup itself missing.

4. **`iterDocuments` paging against the real server.** A fake agrees with any spelling of
   "older than this", including one that fetches the newest page forever or drops a message at
   every page boundary. Use a small `pageSize` over a backup of several chunks and assert: all
   messages distinct, still in descending order, count at least what you uploaded.

5. **`list` finds the backup you just made**, and `list --search` finds it too. `--search`
   hands teleproto a `getMessages` carrying `search`, and only the fake has ever checked that
   shape. Search by file name, by note word, and by backup id.

6. **The chunk-noise assumption, on a backup with several chunks.** `--search` narrows with
   `<term> #telstore` because a chunk caption carries the backup id, so a term alone drags the
   chunks in. That was measured on a **one-chunk** backup (2 hits → 1). Searching an id on a
   multi-chunk backup must return the manifest and no chunk. If that ever fails, `--search` by
   id is broken on exactly the backups where it matters most.

7. **Clean up only what this run created.** Track ids as you go, remove them at the end even
   if an assertion threw, and print what you could not remove with the command to do it by
   hand. Remove the temporary `HOME` too.

## Probing: finding out what Telegram actually does

This is the part a fixed file could never do. When behaviour depends on Telegram's server
state, you are not writing assertions — you are measuring. Rules paid for in this project:

- **Always run a control beside the thing you are measuring.** Enumeration (`iterDocuments`)
  has been right in every measurement ever taken here; a search is the thing under suspicion.
  Search finding nothing means nothing until a walk of the same chat says what is there.

- **Repeat every query, and say so.** Three times, at minimum. A single answer is an answer
  about one moment. `.manifest.json` looked like the fix for exactly as long as one session
  lasted.

- **Measure over minutes, not seconds, for anything about throughput.** Bursts of 10-20s have
  reported speeds 10-19% off and once *reversed the ranking* of concurrency settings. Use a
  full-size chunk if the number is meant to be believed.

- **An explanation that fits the data is not the cause.** Two have died here. First "the `#`
  in `#telstore` confuses the hashtag index" — fit every observation on day one, wrong. Then
  "the index is only slow on chats that were just created" — fit everything, tidy, and took
  five minutes and one throwaway channel to disprove: a channel created from scratch was
  correctly indexed 1.1 minutes later and stayed correct across ten probes over an hour, while
  the channel that stayed empty for hours had also been brand new.

- **So build the measurement that could refute you, not the one that would confirm you.** That
  is the whole difference between the two paragraphs above and a third wrong story in the
  design docs.

- **Write findings into `docs/design/` with the date, the chat, and the conditions** — and
  with what the measurement could *not* see. A number without its conditions becomes a rule
  nobody can re-check.

## After

Report what you ran, what passed, and what you did **not** cover — a run that skipped the
big-file branch and does not say so is worse than no run. If a probe produced a finding,
update the design doc it belongs to (`docs/design/captions.md` for anything about the chat or
the index, `docs/design/telegram-limits.md` for limits, `docs/design/stalls-and-retries.md`
for timing and errors).
