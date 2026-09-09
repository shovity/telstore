// A command meant to be pasted has to survive the shell that receives it: anything a shell
// would take apart comes back quoted, and a path with a space in it is the ordinary case,
// not an exotic one. `status` and `down` both print resume commands, and two copies of this
// rule is how they start disagreeing about which paths are safe to print bare.
const BARE_ARG = /^[A-Za-z0-9_@%+:,./-]+$/

export function shellArg(text) {
  const value = String(text)

  return BARE_ARG.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}
