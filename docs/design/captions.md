# Captions

- `src/caption.js` owns what the chat shows. Captions are plain text — no parse mode, so no
  file name is ever escaped. `#telstore` lives on the manifest alone, and a chunk carrying it
  would turn one backup into thirteen hits in the eye of anyone reading the chat. `--note` rides on the
  manifest for the same reason. `parseNote` folds it onto one line once, so the manifest body
  and the card in the chat can never hold two different notes, and refuses one past
  `MAX_NOTE_LENGTH` rather than cutting it short. The note is the one marker
  `parseManifestCaption` may find missing without calling the card unreadable — every backup
  made before the flag existed has a complete card and no note — and `list` gives it a column
  only when some backup has one, cut to 40 characters there because the whole note is in the
  manifest and on the card for anyone reading it properly.

- **`list` walks the chat; it does not search it.** It used to search for `#telstore`, which
  was the reason that tag existed. Measured 2026-09-07 in a broadcast channel a few minutes
  old: `#telstore` returned nothing, fifteen times over a minute, while the same chat handed
  over all eight of its documents to a plain enumeration and answered a search for a backup id
  with both of that backup's messages. `.manifest.json` returned every manifest in one session
  and none in the next. A day later — same channel, same code — every one of those queries was
  right. Telegram's text index is eventually consistent, and in a new chat "eventually" ran to
  hours. So `list` reported "No backups found" over a chat full of restorable backups, which is
  a sentence people act on: they upload the file again, or they conclude they have lost it.
  Enumeration was correct in every observation, so that is what `list` reads now, and the tag
  stays as a marker for the person looking at the chat rather than for the code.

- Walking costs what searching did in an ordinary chat and more in an extraordinary one: a
  backup is one manifest plus one message per chunk, so twenty backups of a few chunks each
  come back in a single request, and `list` stops the moment it has `--limit` of them.
  Verified against a real account on 2026-09-08 across a backup of 123 chunks: page sizes of
  100, 50 and 7 each walked the same 124 documents, all distinct, all in order.

- **The ceiling is a budget per backup asked for, not one number for every chat.** What the
  walk reads through depends on how big the backups are, never on how many there are: it goes
  from the newest message down and stops at `--limit` manifests, so the three thousandth
  backup costs nothing because it is never reached. The chunks in between are the whole cost.
  A flat 1000 was therefore wrong in both directions at once — twenty backups of 100GB need
  1140 documents and got 1000, while `--limit 5` never needed more than 300. So
  `DOCUMENTS_PER_BACKUP` (60, about a 105GB backup at the default chunk size) times `--limit`,
  stopped at `MAX_LIST_DOCUMENTS` (10000) because `--limit` takes any whole number and
  `--limit 100000` would otherwise ask for six million documents. `--search` uses the same
  arithmetic with `RESULTS_PER_BACKUP` (20), since a result is already a manifest and the
  budget only covers what `matchesTerm` throws away.

- Reaching the ceiling changes the wording — it names what it read rather than making a claim
  about the whole chat — and now names what to do next. "There may be older backups further
  back" is true and offers nothing; `list --search <text>` reaches them without reading the
  chunks in between. The hint is left off `--search`'s own output, where telling someone who
  is already searching to search is noise.

- `list` draws a one-line notice on **stderr** while a long read is in progress, and only onto
  a terminal. Two thresholds, both deliberate: nothing for the first 400ms, because the usual
  walk is a single 165ms request and a line drawn and wiped in the same breath is a flicker
  rather than information; and stderr-and-TTY-only because `list` is a command people pipe
  into `grep`, where a carriage return is rubbish — which is why it does not simply reuse the
  upload bar, whose output is not piped anywhere.

- `findManifestMessage` still searches, by backup id, because walking a chat to find one
  manifest that may be ten thousand messages back is not the same trade. That search was
  right in every measurement above, including the ones where the tag search was not — but it
  is the same index, so a `restore` that cannot find a backup which is plainly in the chat is
  the shape a future bug here would take.

- **`list --search` asks the index; plain `list` still walks.** Same trade as
  `findManifestMessage`: a term matches a backup that may be a year back, and walking to it
  costs a request per hundred documents in between, every time, growing for as long as the
  chat does. Walking is right for the newest twenty backups and wrong for a search.
  `iterManifestSearch` sends `<term> #telstore`. Two details of that query are load-bearing,
  and both cost something to learn:

  - **The tag goes last.** `projex #telstore` returned the one manifest; `#telstore projex`
    returned nothing. A query starting with the hash is read as a hashtag lookup and stops
    ANDing the rest, so leading it would turn every search into "no backups found" — the
    sentence this file already exists to stop telstore saying wrongly.
  - **The tag is there at all** because a chunk caption carries the backup id, so a term
    alone drags the chunks in: `telstore-20260907-207ed9` returned 1 manifest and 1 chunk,
    the same id with the tag returned the manifest by itself. On a backup of a few hundred
    chunks those would fill every page before a manifest appeared, which is the same reason
    `#telstore` was kept off chunk captions in the first place.

- **The index says where to look, `matchesTerm` says what is true.** Every hit is checked
  against the backup id, file name, whole note and creation day before it reaches the table,
  because Telegram's answer is not the answer the user asked for: `2026-09` came back with
  all 23 documents of the chat while `2026-09-07` came back with 3. Shown unchecked, a search
  for a month would list backups from every other month. The pass costs no request — the
  captions are already in hand — and it is the difference between narrowing and guessing.

- What `--search` cannot do, and the help says so: **whole words only.** `projex` found
  `projex.zip`; `proje`, `proj`, `pro` and `pr` each found nothing, and `chunk` found all 11
  manifests while `chu` and `ch` found none. Single characters are stranger still — `t` and
  `M` returned the whole chat — so no prefix rule was inferred from them. The failure mode is
  a miss, never a wrong row, and the empty answer names it and points at `list` without the
  flag.

- Measured 2026-09-08 against the real backup chat: 23 documents, 11 manifests, oldest from
  2026-09-05. `#telstore` returned 11 manifests and 0 chunks, exactly matching the walk, and
  every query repeated three times gave the same count. ~165ms per request, one request per
  100 manifests. **Two limits on all of it:** this is one session, and the chat is small —
  nothing here measures a chat with thousands of backups in it, and the cost estimates for
  one are arithmetic on that 165ms, not observation.

- **The tidy explanation for 2026-09-07 was tested and did not survive.** "The index is only
  behind on chats that have just been created" fits every observation up to that point and is
  the reason to think `list` could stop walking. So a fresh broadcast channel was created on
  2026-09-08 at 07:33:55 UTC, three backups uploaded into it by 07:34:32, and the index
  watched against a walk of the same chat as the control. At **1.1 minutes old** the tag
  search already returned all three manifests and nothing else, and matching by file name,
  by note word and by backup id all worked. Ten probes over the next hour — 1, 3, 5, 8, 12,
  18, 25, 35, 45 and 60 minutes — every one identical, never a single disagreement with the
  walk.

  So a brand-new channel is indexed within a minute, and the channel that stayed empty for
  hours on 2026-09-07 was also a brand-new channel. Same condition, opposite outcome. The
  failure is real and reproducible in the record, but **nothing here predicts when it
  happens**, which is worse than either neat story: it cannot be ruled out and it cannot be
  anticipated. That is why `list` still walks and only `--search` pays the index, why the
  empty search answer points back at `list`, and why anyone reading this before deleting the
  walk should assume the failure can return without warning.
