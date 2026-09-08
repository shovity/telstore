# Settings and flags

- `src/settings.js` is the one place that knows a setting exists: flag, default, parsing,
  printing. Precedence is flag, stored setting, built-in default; **flags never write**, and
  `config` is the only thing that does. Two definitions of a default is how `config` starts
  lying about what will actually happen.
- A setting's flag is its key in kebab-case, without exception. `chat` used to answer to `--to`,
  which read well on an upload and nowhere else: `restore`/`list`/`delete` do not send anything
  to that chat, they look in it, so both their errors had to spell out that the flag "points at
  the right chat" — a name needing a gloss is a name that failed. It also made `origin` print
  two spellings of one setting (`Invalid --to` from a flag, `Invalid chat in <config>` from the
  file). `--to` was removed rather than kept as an alias: `parseArgs` refuses it by name, so an
  old script stops instead of sending a backup somewhere nobody chose, and one setting keeps one
  name. `ALIASES` still earns its place for `chunk-size` and the two concurrencies.
- Five flags have no setting behind them, none of them a preference: `--out` names where one
  restore goes (and is refused outright against several ids), `--yes` answers a question about
  one particular run (stored, it would be standing permission never to ask before destroying
  a backup), `--note` says what one upload is about (stored, it would label every backup for
  months with a sentence nobody remembers writing), `--search` asks one question of one
  listing (stored, it would quietly filter every `list` afterwards by a word nobody remembers
  setting, and an empty one is refused rather than answered with everything), and `--token`
  takes **no value** —
  a token on the command line sits in `ps` and in shell history, so it is pasted at a prompt
  that does not echo. `login` refuses a positional argument rather than ignoring one.
- The `--chunk-size` refusal keys off the *source* of the size, not its presence: a config
  `chunkSize` says what to use when nobody asks, so a resumed backup keeps its own size; only
  the flag is somebody asking. `resolveSettings` returns `source(key)` for this, and throws on
  an unknown key rather than returning `undefined` — a typo would turn the refusal into a
  silent resume at the wrong size.
- Upload and download carry separate concurrency: upload counts 512KB parts, download counts
  8MB slices, so one shared value would hold sixteen times as much in flight on a restore.
  Each slot also raises the bandwidth needed for a batch's last request to arrive inside the
  60s deadline — 32 upload slots need 2.1 Mbps, 64 need 4.4. That floor is why the upload
  default is 32 and not the 64 that measured marginally faster: a slow link must never be told
  it stalled. `src/chunking.js` carries the measurements.
- Errors are reported against where the value came from: `Invalid --upload-concurrency: "0"`
  for a flag, `Invalid uploadConcurrency in ~/.telstore/config.json: "0"` for a stored one.
  Same reasoning killed *"run again without `--chat`"* — useless to someone whose destination
  came from the config, so the message names the chat to pass instead. `runStatus` is the
  exception: it is run *because* something is wrong, so an unparseable setting is printed in
  its own row rather than thrown, leaving the account line and unfinished backups readable.
