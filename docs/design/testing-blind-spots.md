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

Both threshold branches then have to meet a real account before a release, and that used to be
a sentence asking somebody to remember. It is `npm run test:e2e` now:

```bash
TELSTORE_E2E_CHAT=@some-chat-of-your-own npm run test:e2e
```

It uploads two backups — one cut into chunks under 10MB, one with a chunk above it and a
remainder below, so a single run crosses `SaveFilePart`/`SaveBigFilePart` both ways — verifies
each, restores it, compares sha256 against the file that went up, and deletes it again. It
also removes one chunk message behind telstore's back and checks `verify` notices, which is
the `MessageEmpty` shape no fake client can be trusted to imitate.

It lives in `e2e/`, not `test/`, so `npm test` — the gate — can never reach a real account,
and it skips itself unless `TELSTORE_E2E_CHAT` is set. It borrows the machine's own login but
runs every command under a temporary `HOME`, because `logout` and `config` write: a run
against the real `~/.telstore` would destroy the session of whoever is running the tests. It
deletes only the ids it created.

Its first run found something the whole suite had been blind to: `list` found nothing in a
newly created broadcast channel, though every backup in it restored perfectly. The first
diagnosis written here was wrong — it blamed the `#` on `#telstore` and Telegram's hashtag
index — and a second day of measuring took it apart: the same query in the same channel was
right the next morning. What is true is that Telegram's text index is eventually consistent
and can be empty for hours in a new chat, while the documents themselves are always there for
the asking. `list` walks the chat now; `docs/design/captions.md` carries the measurements.

Two lessons worth more than the bug. A measurement taken once is a measurement of one moment:
".manifest.json" looked like the fix for exactly as long as one session lasted. And an
explanation that fits the data is not the same as the cause — the hashtag story fit every
observation available on the first day and was still wrong.
