# Terminals

**Terminals too.** `src/prompt.js` first opened a readline per question and passed against a
fake stream; a real pty does not take turns — the first interface keeps the listener, so a
second question reads nothing and reports Ctrl-D. One interface asks every question, with a
curtain in front of its output, and `terminal` follows `stdin.isTTY` (that flag is what stops
the tty driver echoing, leaving the curtain as the only thing between keyboard and screen).
The curtain also draws the mask, because a prompt showing nothing reads as the hang this
project refuses everywhere: the count comes from `rl.line`, the public property — overriding
`_writeToOutput` looks right and is not, since Node's internals have called a symbol-keyed
method since well before 22. One asterisk per character, capped to the question's line with a
trailing `…`; the cap is load-bearing, since the redraw is `\x1b[2K\r` plus the whole line and
a wrapped mask would leave stale asterisks on the rows above.

Verify any prompt change under a real pty, pacing input like a human — lines arriving before
the prompt exists are echoed by the tty and dropped, which looks exactly like a bug and is not:

```bash
( sleep 1.5; echo secret ) | script -qec "node bin/telstore.js token" /dev/null
```

Check asterisks appear as the line is typed, come back when a character is erased, and that
the secret never does.

**Ctrl-C is not always an exit.** `bin/telstore.js` printed a line and called
`process.exit(130)` for as long as every command kept what it had already sent on purpose — a
file upload's chunks are what the next run resumes onto, so leaving on the spot was the
truthful thing to do. A stream upload is the one that cannot: its chunks are removed when the
run fails, because nothing will ever point at them again, and removing them is a network
round trip per batch. So a command may hand out an abort through `deps`; SIGINT calls it and
the process stays alive while the run unwinds itself. A second Ctrl-C is somebody saying they
will not wait, and it leaves at once with the id and the `delete` command that finishes the
job by hand. A deadline (`CLEANUP_DEADLINE_MS`) says the same thing on its own, because the
alternative to a deadline is a terminal held open by a network that is never coming back,
with no way out but a keypress nobody has been told to press.

**The deadline timer must not be `unref()`ed, and it will look to a later reader as though it
should be.** A timer nothing awaits, in a process that exits when its run finishes, is exactly
the shape of a handle somebody tidies away — and the suite stays green when they do, while the
behaviour becomes the worst one available: with `.unref()` node leaves with **0** the instant
nothing else is pending, which mid-rollback is true, so telstore reports success and exits
while the chunks it promised to remove are still in the chat. That was measured against the
real binary, not reasoned about. The timer does two jobs and only one of them is obvious: it
is the deadline, and it is the one handle keeping the process alive for the rollback. The
upload arm clears it in a `finally`, so a rollback that finishes normally never meets it.

**One contradiction is known and deliberately left.** A SIGINT landing in the sub-second window
after the manifest has gone out but before the run has settled prints `Stopping. Backup … is
removing the chunks it already sent`, and then the run's own `Done.` a moment later. Both lines
were true when the code that wrote them ran; the last line and the exit code are the correct
ones, and nothing is left behind in the chat or on disk. The fixes are worse than the flaw: a
handler that first waits to find out how far the run got is a handler that does not answer
Ctrl-C, which is the one thing this handler exists to do promptly. Everything *after* the run
ends is already covered — the `settled` flag is checked before any of the messages, because
said about a run that has finished they are all false at once.
