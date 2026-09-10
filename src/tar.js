// What the tar shortcuts know about names, and all they know. Pure strings: the parser needs
// it before anything is open and the restore command needs it before anything is downloaded,
// so it belongs to neither of them.
//
// `tarc` always compresses. A backup called a.tar holding gzip bytes would be a name that
// lies to whoever restores it, and the name is what `list` shows and `--search` matches, so
// it is the one part of this that cannot be left to the person typing.
const GZIP_SUFFIXES = ['.tar.gz', '.tgz']

export function isGzipName(name) {
  const lower = String(name).toLowerCase()

  return GZIP_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

// Appended in lower case, matched without case: A.TAR becomes A.TAR.gz rather than
// A.TAR.tar.gz, because the capitals are how someone typed it and not a second intention.
export function archiveName(name) {
  if (isGzipName(name)) return name
  if (String(name).toLowerCase().endsWith('.tar')) return `${name}.gz`

  return `${name}.tar.gz`
}
