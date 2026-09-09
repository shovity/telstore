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
- A delete also drops every `restore-*` record naming that backup, next to where it drops the
  upload record and for the same reason: the chunks are gone, so `status` would go on offering
  a resume command that can only fail. `findRestores` matches the id *inside* each file, like
  `findStates` — the file name hashes the target path, which delete never knows. Every record
  claiming the id goes, not the first: one backup restored to two places is two records.
  What does **not** go is the `.partial` itself. It is the user's data, sometimes gigabytes of
  it, and this command removes what was asked for and nothing else — the same line `pruneRestores`
  will not cross. It is named on the way out instead, because nothing can finish it now, and a
  file nobody is told about is one nobody will ever think to reclaim.
