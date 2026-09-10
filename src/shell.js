// A command meant to be pasted has to survive the shell that receives it: anything a shell
// would take apart comes back quoted, and a path with a space in it is the ordinary case,
// not an exotic one. `status` and `down` both print resume commands, and two copies of this
// rule is how they start disagreeing about which paths are safe to print bare.
const BARE_ARG = /^[A-Za-z0-9_@%+:,./-]+$/

export function shellArg(text) {
  const value = String(text)

  return BARE_ARG.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

// The one line in telstore that destroys data when it is wrong. `delete` resolves its own
// destination from config and then fires the recorded message ids at whatever peer that turns
// out to be, so a command pasted next week — or one built here under a `--chat` this run was
// given — would remove whatever happens to carry those ids in the chat it resolves. Naming a
// chat that turns out to be the default costs a few characters; leaving it out when it is not
// costs somebody else's messages, and nothing undoes that. Four commands print this string
// (`upload-stream`'s rollback, `cli`'s second Ctrl-C, `status`, `down`) and they had four
// copies of the rule, which is how three of them stayed right and one drifted.
//
// The chatless branch is not a convenience: it is for the single caller that genuinely does
// not know where the chunks went. `bin/telstore.js` holds the chat the run handed it, and a
// Ctrl-C arriving before the run ever reported one leaves the id — the only part of the
// message with any value — rather than printing `--chat undefined`, which `delete` would read
// as no destination at all while looking like one. A caller that would rather print nothing
// than a command missing its chat decides that for itself before calling: `down` does, and
// says why beside its own check.
export function deleteCommand(id, chat) {
  const where = chat === null || chat === undefined ? '' : String(chat).trim()

  return `npx telstore delete ${shellArg(id)}${where === '' ? '' : ` --chat ${shellArg(where)}`}`
}
