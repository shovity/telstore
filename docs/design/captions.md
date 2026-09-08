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
