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
