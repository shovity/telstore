# `delete`

The command that destroys data on Telegram on purpose — `down` is the one that destroys it
on this machine (`docs/design/down.md`) — so the rule runs the other way: nothing removed
that the user did not ask for, nothing reported gone that is still there.

- Chunks first, manifest last, local record last of all — the manifest is the only list of
  message ids, so removing it first strands every remaining chunk unnamed. Leaving it until
  last means an interrupted delete finishes by running the command again (Telegram says
  nothing about an id already gone). The cost is a window where `list` shows a backup
  `restore` will refuse: loud and fixable, the trade this project always takes.
- `delete` does not go through `parseManifest` — a manifest failing layout checks is exactly
  the broken backup somebody is removing, and refusing to read it leaves the only way out
  through the Telegram app. `manifestMessageIds` checks the one field `parseManifest` never
  does: a `msgId` that is not a whole positive number refuses the *whole* manifest, because a
  message id names something about to be destroyed for good. A manifest whose body names a
  different backup is refused for the same reason.
- `src/client.js` batches ids itself: teleproto's `deleteMessages` splits them into hundreds
  and fires every batch through `Promise.all` — a hundred requests in flight under neither
  `withRetry` nor the stall deadline. Its peer resolution and its choice between
  `channels.DeleteMessages` and `messages.DeleteMessages` are still what telstore calls,
  because that choice is what a fake client would never catch us getting wrong.
- **`manifestMsgId` looks like a field somebody forgot to fold into `stateMessageIds`. It is
  not, and folding it in breaks two things at once.** It exists because a stream upload's
  rollback can fail partway, and the usual reason it is rolling back at all is that the network
  broke — a rollback that got as far as the chunks but not the card leaves a manifest standing
  in the chat over nothing. `delete` normally finds a manifest through `searchManifest`, which
  asks Telegram's text index, and this repo has *measured* that index returning nothing for a
  channel whose documents were all plainly there, with nothing known that predicts when it
  happens (`docs/design/captions.md`). So a stream run writes the card's message id into its own
  record before that record can be left behind, and `stateManifestId` reads it when the search
  comes up empty. Without it, `delete` takes the chunks away and leaves the card advertising a
  backup `restore` cannot fulfil, findable by nothing on this machine ever again.

  Why it is read by `stateManifestId` and not simply added to `stateMessageIds`, which is the
  tidy-looking change: `stateMessageIds` fills `chunkIds`, and `chunkIds` is what goes out
  first, so a manifest id among them would be destroyed **with** the chunks instead of after
  them — the chunks-first, manifest-last order the first bullet of this file exists to keep,
  given up for a field that is only ever read on the failure path. And every count in the
  report is derived from that same list, so a manifest counted among the chunks makes each of
  them one too high: "2 chunk messages" for one chunk and a card, in the sentence someone is
  reading to decide whether to say yes. Two rules broken, in a path nobody exercises by hand.

  `status` reads the same field to say whether a manifest is in the chat, and must answer about
  it exactly as this does: `stateManifestId` treats an explicit `null` as an absent value, so
  status tests `== null` rather than `=== undefined`. A record carrying a null had status
  promising "the manifest its record names" while `delete` reported none — two commands
  contradicting each other about one record, which is the failure this field was added to
  prevent rather than one to introduce alongside it.
- A delete also drops every `restore-*` record naming that backup, next to where it drops the
  upload record and for the same reason: the chunks are gone, so `status` would go on offering
  a resume command that can only fail. `findRestores` matches the id *inside* each file, like
  `findStates` — the file name hashes the target path, which delete never knows. Every record
  claiming the id goes, not the first: one backup restored to two places is two records.
  What does **not** go is the `.partial` itself. It is the user's data, sometimes gigabytes of
  it, and this command removes what was asked for and nothing else — the same line `pruneRestores`
  will not cross. It is named on the way out instead, because nothing can finish it now, and a
  file nobody is told about is one nobody will ever think to reclaim.
- The card the walk meets is handed on as the raw `Api.Message`, the same thing
  `findManifestMessage` returns, because both of them feed `readMessageBytes` and teleproto's
  `downloadMedia` treats a non-`Api.Message` argument as media itself, matches it against no
  `Api` class, and throws `Cannot download media of type object`. The flat document
  `iterDocuments` yields is exactly that argument. It shipped wrong once and no fake noticed,
  which is `docs/design/testing-blind-spots.md`'s rule in one line: the tests assert the shape
  handed over, not the fake's willingness to take anything.
- **`delete` reads the chat for chunks carrying the backup id, and does not take the local
  list for what is there.** The reason it has to is dated 2026-09-09 and written up in
  `docs/design/data-integrity.md`: a stream upload left behind by a second Ctrl-C put a chunk
  in the chat that its own record never named, and the `delete` line that run printed removed
  the two ids it knew about, said "Done", and left 12MB standing. Three other fixes were on
  the table — recording each send's intent before it goes out, tearing the socket down before
  the process leaves, and simply softening the wording — and each of them closes one escape
  route. The walk was taken instead because it does not need the route named: a chunk in the
  chat is found because it is in the chat, whatever put it there, including the causes nobody
  has enumerated yet. It also picked up two orphans that were already possible and that nobody
  had gone looking for — a file upload that dies between `sendChunk` returning and
  `markChunkDone` writing, whose next run re-sends that chunk and strands the first copy under
  a manifest that names only the second, and a run whose record was cleared before it held an
  id at all, where `delete` used to answer "No backup found" over chunks that were plainly
  there.
- **What makes a document this backup's chunk is the file name telstore wrote on it**, through
  `isChunkFileName`, and never the caption beside it — the rule `findManifestMessage` already
  keeps and for the identical reason: a caption is text a person can edit and a file name is
  not. The number after `.part` is checked and never read back. What the check is for is the
  other direction: `<id>.partial` and `<id>.part0001.bak` are names telstore never writes but
  a person can give a file they upload themselves, and the prefix alone would have destroyed
  them along with the backup — the one mistake in this command that nothing undoes.
- **Where the walk stops: every floor it has must agree, and neither of the two is trusted
  alone.** The first draft tried them in order and stopped at whichever fired first, which
  reads as the cheap option and is the expensive mistake — each floor has a way of sitting
  *above* a chunk that is really there, and a floor one document too high sets the flag that
  prints "Done".
  - *The oldest message id this backup is known to have sent.* Needs no clock: telstore sends
    chunk 0 first and records each id as it lands, so a record's `done` and a manifest's chunk
    list are both prefixes of what the run actually sent, and the smallest id either names is
    the backup's first message. Its blind spot is that both of those are files a person can
    edit, which is why `stateMessageIds` and `manifestMessageIds` check every id's shape
    before anything is destroyed — and a record with chunk 0 taken out of it passes both those
    checks while lifting this floor over chunks that are still in the chat.
  - *The day the backup id carries, less one day.* Derived from the id the user typed rather
    than from any file, so nothing on disk can move it. Its blind spot is the other one:
    `newBackupId` stamps that day from the clock of the machine making the backup and a
    document's date comes from Telegram's. The day of slack is for that gap and nothing else,
    and it is subtracted — a floor above the backup's own first message is the failure, so the
    slack only ever has to be able to point downwards.
  Requiring both makes each one's blind spot the other's problem: an id floor lifted by an
  edited record is held down by the date, and a date floor lifted by a wrong clock is held
  down by the id. It costs one extra day of documents read, which is the cheapest thing in
  this entry, and the alternative was writing "a hand-edited record can hide chunks" into this
  file as though naming a hole were the same as closing one. Where only one floor exists — an
  id telstore did not mint carries no day — it decides alone, and where neither does there is
  only the budget.
  - *`MAX_DELETE_DOCUMENTS`, 20000.* Its own number rather than `list`'s `MAX_LIST_DOCUMENTS`,
    which is exactly 10000 and would stop this walk one document short of the largest backup
    telstore makes: `MAX_CHUNKS` chunks with a manifest over them is 10,001 documents of
    telstore's own before a single foreign one is counted.
  Chunks the walk finds deliberately do **not** lower the floor, tempting as that is. A chunk
  removed by hand out of the middle of a backup breaks the chain, and the next document down
  would then be below the last one found rather than above it — a walk that stops early and
  says nothing, which is the failure this whole entry exists to remove.
- **The walk starts under the card when the chat search returned one.** A backup's manifest is
  the last message its run sends, in both upload paths, so nothing of that backup is newer than
  its own card and everything posted since belongs to somebody else. `iterDocuments` grew an
  `offsetId` for it. Without that a delete of a year-old backup would read every document
  posted in the chat since, a page per hundred, to find chunks that all sit under the card.
- **Every delete walks, not only the ones a record calls a stream.** The gate would have been
  cheap to write and it would have covered the measured case exactly, which is the argument
  against it: the file path has its own way of stranding a chunk (above), and a rule shaped
  around the one leak that has been seen is a rule that misses the next one. The cost is
  bounded by the backup's own footprint — roughly one read per hundred chunks, against a
  command that is already sending one delete per hundred — because both ends of the walk are
  the backup's own messages.
- **A batch does not walk for an id that neither the search nor a record knows.** `runDeletes`
  asks about every id at once and before anything is destroyed, so a walk apiece would turn one
  mistyped id in a list of five into minutes spent reading somebody's archive. It refuses as it
  always did; what changed is that it no longer says "not found in <chat>", which after this
  entry is a claim about a question it did not ask. It says there is no manifest, and points at
  the single-id form that does read the chat.
- **"Done" is a claim, and only a walk that reached a floor earns it.** A walk stopped by
  `MAX_DELETE_DOCUMENTS` removed everything it found and cannot say what is behind it, so the
  report drops the word and says how far it read instead — and the "no backup found" refusal
  says the same, because "not found" over a chat nobody read to the bottom of is a statement
  about somewhere the command never looked. Chunks the walk found that nothing on this machine
  names are said twice: once above the question that authorises the removal, counted inside the
  number that question quotes, and once in the closing report. Neither line is alarm — a leftover
  chunk is what the walk was added to find, and finding one is it working.
- The walk is now a second way to the card `manifestMsgId` was added for, since it meets the
  manifest on the way down whenever the text index has gone quiet. The field stays anyway: it
  is one field against a read of the chat, `status` answers from it without connecting at all,
  and the bullet above about folding it into `stateMessageIds` is untouched by any of this.
- **What none of this can see.** The fake client cannot produce the race that motivated it —
  that is the whole finding — so the tests prove the walk finds a chunk the record does not
  name, that the wording is honest, and that a delete with nothing stray behaves as it did
  before, and nothing more. Against a real account this has not been run: the next e2e should
  repeat the second-Ctrl-C stream upload and check that the printed `delete` now empties the
  chat in all three runs rather than two. What remains uncovered is what neither floor bounds:
  a chat where the walk reaches `MAX_DELETE_DOCUMENTS`, which is the one ending that does not
  claim to be complete and says so instead.
