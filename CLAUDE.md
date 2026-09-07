# telstore

A CLI that splits large files into chunks, uploads them to Telegram over MTProto,
and restores them byte-for-byte.

## Language

**This project is English-only.** Code, comments, user-facing strings, test names,
documentation and commit messages are all written in English.

## Commands

```bash
npm test        # node --test over test/**/*.test.js
```

No build step, no linter. `npm test` is the whole gate.

## Constraints

- Node 18+, pure ESM, no TypeScript, no transpilation.
- Exactly one runtime dependency: `teleproto` (the maintained fork of the deprecated
  GramJS; same session string format, so nobody logs in again). A second one needs a
  reason that survives scrutiny.
- Tests use the built-in `node:test` runner only.
- Style: no semicolons, single quotes, two-space indent.

## The rule everything else serves

**Never produce wrong data silently.** A backup that cannot be restored must fail
loudly at upload time; a restore that cannot reproduce the original bytes must fail
rather than hand over a plausible-looking file. These checks exist purely for that and
must not be relaxed to make a test pass.

## Conventions

- Commands take collaborators through a `deps` object so tests can pass fakes; keep that seam
  rather than importing the real client directly.

## Where the reasoning lives

The decisions this project rests on were reached once, at a cost, and most of them are
easy to undo by accident. They live in `docs/design/` rather than here, so a session
pays only for the part it is touching. **Read the file on a row before changing
anything that row names** — not afterwards, and not only when something looks odd.

| Before you change | Read |
| --- | --- |
| `src/manifest.js`, `src/state.js`, `src/chunking.js`, `src/config.js` | `docs/design/data-integrity.md` |
| `src/commands/restore.js`, the resume scan | `docs/design/data-integrity.md` |
| `src/stall.js`, `src/retry.js`, anything that waits on the network | `docs/design/stalls-and-retries.md` |
| `src/token.js`, `src/session.js`, `src/commands/login.js`, `src/commands/token.js` | `docs/design/session-tokens.md` |
| `src/commands/delete.js`, the delete path in `src/client.js` | `docs/design/delete.md` |
| `src/sources.js`, `runUploads` / `runRestores` / `runDeletes`, batch confirmation | `docs/design/batches.md` |
| `src/settings.js`, `src/cli.js`, `src/commands/config.js`, any flag | `docs/design/settings-and-flags.md` |
| `src/caption.js`, `src/commands/list.js`, anything the chat shows | `docs/design/captions.md` |
| `src/client.js`, `src/uploader.js`, `src/downloader.js`, `bin/telstore.js` | `docs/design/module-boundaries.md` |
| `src/prompt.js`, `src/confirm.js`, anything a terminal draws | `docs/design/terminal-prompts.md` |
| any call that hands an object to teleproto, or a test that fakes one | `docs/design/testing-blind-spots.md` |
| chunk sizes, part sizes, `MAX_CHUNKS`, `MAX_CHUNK_SIZE` | `docs/design/telegram-limits.md` |
