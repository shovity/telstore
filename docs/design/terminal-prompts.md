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
job by hand. The one piece of work it does before going is `unlinkSync` on the chunk file the
run was buffering into, which the run itself would have removed had it been allowed to unwind:
one local syscall, no await, nothing that can hang, since anything else here would be waiting
on exactly what this exit refuses to wait for. It sits in `leave`, the funnel every exit the
handler leads to comes through, so the deadline below gets it too. `docs/design/data-integrity.md`
has the measurement that put it there and what `status` does about the endings no handler ever
sees. A deadline (`CLEANUP_DEADLINE_MS`) says the same thing on its own, because the
alternative to a deadline is a terminal held open by a network that is never coming back,
with no way out but a keypress nobody has been told to press.

**The deadline timer must not be `unref()`ed, and it will look to a later reader as though it
should be.** A timer nothing awaits, in a process that exits when its run finishes, is exactly
the shape of a handle somebody tidies away. It does two jobs and only one of them is obvious:
it is the deadline, and it is the one handle keeping this process alive while the rollback
runs. Node's own stdio handles do not hold the loop open, so as soon as the rollback is waiting
on something that holds no handle either — a delete that has gone out and not come back — there
is nothing pending, node leaves with **0**, and telstore reports success with the chunks it
promised to remove still in the chat. That was measured, not reasoned about. The upload arm
clears the timer in a `finally`, so a rollback that finishes normally never meets it.

**What the gate catches of that, and what it does not.** Adding `.unref()` does turn
`test/bin.test.js` red, in exactly one place: *a second Ctrl-C leaves at once and names what may
still be in the chat* fails with `null !== 130`. That test hangs the fake's `deleteMessages` on
purpose, which is precisely the rollback that holds no handle of its own. The first-Ctrl-C test
stays green under the same mutation, because there the fake's delete is a 200ms `setTimeout` —
a pending timer, holding the loop open for as long as the rollback takes, doing by accident the
job the deadline is there to do on purpose. So the mutation is caught, by one test, through one
shape of rollback; the ordinary shape is covered only by whatever the dependency happens to have
pending, which is to say not covered. Green here is not a licence, and none of it is measured
against Telegram: the binary runs out of a copied tree with `src/client.js` faked, which
`docs/design/testing-blind-spots.md` explains — a real SIGINT, the real handler, the real exit
path, and a stand-in for the network.

**One contradiction is known and deliberately left, and it is written here rather than only in
a comment because it is a user-visible untruth and those get written down.** The window is
between `sendManifest` returning inside `runStreamUpload` and the `finally` in
`bin/telstore.js` setting `settled` — a handful of event-loop ticks, everything the run still
has to do after the card is in the chat. A SIGINT landing in it prints `Stopping. Backup … is
removing the chunks it already sent`, over a run that removes nothing, and then the run's own
`Done.` a moment later and an exit code of 0 for a backup that is complete and valid. Both
lines were true when the code that wrote them ran; the last line and the exit code are the
correct ones, and nothing is left behind in the chat or on disk — which is why it ships. Note
what is *not* claimed: the width of that window has never been measured, only reasoned about
from what sits between the two points — two state writes, the closing line, and the client
disconnect — every one of which is longer on a slow disk or a dead socket than the "moment"
this paragraph used to call it.

The fixes are worse than the flaw: a handler that first waits to find out how far the run got
is a handler that does not answer Ctrl-C, which is the one thing this handler exists to do
promptly, and a flag set a line earlier — before `sendManifest` rather than after the run —
would move the lie rather than remove it, to a Ctrl-C that arrives while the manifest really is
still going out. Everything *after* the run ends is already covered: the `settled` flag is
checked before any of the messages, because said about a run that has finished they are all
false at once.
