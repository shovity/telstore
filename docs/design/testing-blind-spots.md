# What the test suite cannot see

Every automated test talks to a fake client that accepts whatever it is given, so the suite
cannot catch a mismatch with teleproto's real API surface. This has bitten twice, most
recently when the GramJS move changed `iterDownload` to `(file, params)`: 459 tests stayed
green against a call the real client refuses outright, and the time before that a published
release shipped a restore that was completely broken. Caught only by driving the real
`iterDownload` — which is what `test/downloader.test.js` now does, with the network stubbed
and nothing else.

**A fabricated error shape is the same blindness.** `test/retry.test.js` built flood errors by
hand; under GramJS every real flood error carried the literal `errorMessage` "FLOOD", so
`floodWaitSeconds` matched nothing and each `FLOOD_WAIT` was retried on the ordinary backoff —
asking again inside a running ban, which is how a ban gets longer. teleproto's
`RPCMessageToError` keeps the server's string, and `floodWaitSeconds` reads the code and the
seconds rather than the spelling. `test/smoke-import.test.js` holds the two together with an
error built the way `MTProtoSender` builds one.

When you touch code that hands an object to teleproto, assert against teleproto's own helper
(as `test/downloader.test.js` does with `getFileInfo` and `iterDownload`) rather than the fake.

Both threshold branches have to meet a real account before a release. That was a sentence
asking somebody to remember, then a fixed file (`e2e/live.test.js`), and is now the **`e2e`
skill** in `.claude/skills/e2e/`. Nothing about a real account is reachable from `npm test` —
the gate still cannot touch the network.

The file became a skill because the findings that mattered most were never in it. Its
assertions caught what they were written to catch; what took the design apart came from
probing the server and, later, from building a measurement designed to refute what we already
believed. A fixed file cannot decide to do that, and both times the decision was worth more
than the assertions.

The trade is real and named in the skill: a file runs the same way every time and a skill does
not, so the checks that used to be guaranteed are written there as **not optional** — both
threshold branches with sha256 compared end to end, `verify` catching a chunk deleted behind
telstore's back (the `MessageEmpty` shape no fake imitates), `iterDocuments` paging against
the real server, `list` and `list --search` finding what was just uploaded, and cleanup of
only the ids that run created. It borrows the machine's login but runs every command under a
temporary `HOME`, because `logout` and `config` write: a run against the real `~/.telstore`
would destroy the session of whoever is running it. It never uses the real backup chat,
because it runs `delete --yes`.

Its first run found something the whole suite had been blind to: `list` found nothing in a
newly created broadcast channel, though every backup in it restored perfectly. The first
diagnosis written here was wrong — it blamed the `#` on `#telstore` and Telegram's hashtag
index — and a second day of measuring took it apart: the same query in the same channel was
right the next morning. `list` walks the chat now; `docs/design/captions.md` carries the
measurements.

The second diagnosis — "the index is eventually consistent, and a *new* chat can be empty for
hours" — stood here for a day and is also gone. It was tested on 2026-09-08 rather than
believed: a broadcast channel created from scratch, three backups in it within 37 seconds, and
the tag search watched against a walk of the same chat as the control. At 1.1 minutes old the
search already returned all three manifests and nothing else; ten probes out to an hour never
disagreed with the walk once. A brand-new channel is indexed within a minute — and the channel
that stayed empty for hours was also brand new.

So the honest statement is smaller than either story: the failure is real and in the record,
the documents themselves were right every time they were asked for, and **nothing known
predicts when the index will be wrong**. That is worse than a mechanism, because it can be
neither ruled out nor anticipated, and it is why `list` still walks while only `--search` pays
the index.

Three lessons, each worth more than the bug. A measurement taken once is a measurement of one
moment: ".manifest.json" looked like the fix for exactly as long as one session lasted. An
explanation that fits the data is not the cause — the hashtag story fit every observation
available on the first day and was still wrong. And the replacement explanation deserves the
same suspicion as the one it replaced: "only new chats" was tidy, fit everything, took five
minutes and one throwaway channel to disprove, and would have been believed indefinitely if
nobody had built the measurement that could refute it.
