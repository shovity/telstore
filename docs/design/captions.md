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
  `MAX_LIST_DOCUMENTS` (1000) is where it gives up, and there the wording changes — it names
  what it read rather than making a claim about the whole chat. Verified against a real
  account on 2026-09-08 across a backup of 123 chunks: page sizes of 100, 50 and 7 each
  walked the same 124 documents, all distinct, all in order.

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
  one are arithmetic on that 165ms, not observation. The channel that returned nothing on
  2026-09-07 was hours old and answered correctly the next day; that is consistent with the
  index being slow on new chats and with several other explanations, so `list` keeps walking
  by default rather than resting on the neater story.
