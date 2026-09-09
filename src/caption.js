import { formatBytes } from './progress.js'

// Captions are plain text on purpose. Telegram would render bold through a parse mode,
// but that turns every file name into something that has to be escaped correctly, and
// the fake client the tests talk to would never notice a mistake there.

// The hashtag is what `list` searches for, and it lives on the manifest alone: chunk
// captions stay out of that search so a twelve-chunk backup is one hit, not thirteen.
export const MANIFEST_TAG = '#telstore'

// A file name may legally contain a newline or a tab, and either one would push the
// rest of the card down a row and take its shape apart.
function oneLine(name) {
  return String(name).replace(/\s+/g, ' ').trim()
}

// Telegram takes 1024 characters in a caption, and the card around the note already spends
// some of them — a file name alone may be 255. 500 leaves both room to spare.
export const MAX_NOTE_LENGTH = 500

// A note is written at a shell prompt and read in two places: the manifest body and the card
// in the chat. Folding it here, once, is what keeps those two from holding slightly different
// notes and leaving nobody able to say which one was typed.
export function parseNote(raw) {
  if (raw === undefined || raw === null) return null

  const note = oneLine(raw)

  if (note === '') {
    throw new Error(
      '--note is empty. Write the note itself, or leave the flag off — a backup with a blank ' +
        'note is one telstore had something to say about and did not.',
    )
  }

  if (note.length > MAX_NOTE_LENGTH) {
    throw new Error(
      `--note is ${note.length} characters, and a caption has only room for ${MAX_NOTE_LENGTH} ` +
        'once the rest of the card has had its share. Shorten it: telstore will not cut it ' +
        'short by itself, because half a note read as a whole one is exactly the kind of ' +
        'plausible wrong answer this tool exists to refuse.',
    )
  }

  return note
}

function utcMinutes(createdAt) {
  return `${new Date(createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

// A stream knows its chunk number and not its count. "3/?" would be a question mark in the
// chat forever; the number alone is true at the time it is written, and the manifest card
// carries the final count.
export function chunkCaption({ id, number, total }) {
  return total === null || total === undefined
    ? `📦 ${id} · ${number}`
    : `📦 ${id} · ${number}/${total}`
}

export function manifestCaption({ id, name, size, chunks, createdAt, note = null }) {
  return [
    `📄 ${oneLine(name)}`,
    `💾 ${formatBytes(size)} · ${chunks} chunk${chunks === 1 ? '' : 's'}`,
    `🆔 ${id}`,
    `📅 ${utcMinutes(createdAt)}`,
    // Below the facts telstore knows, above the line that says how to get the file back:
    // the note is the one part of the card a person wrote, so it reads last of the four.
    ...(note ? [`📝 ${oneLine(note)}`] : []),
    '',
    `↩ npx telstore restore ${id}`,
    MANIFEST_TAG,
  ].join('\n')
}

function marker(lines, emoji) {
  const found = lines.find((line) => line.startsWith(`${emoji} `))
  return found ? found.slice(emoji.length + 1).trim() : null
}

// list reads what the chat shows, and a caption is text a person can edit. Anything that
// does not carry the whole card is reported as unknown rather than half-guessed: a backup
// listed with invented numbers is worse than one listed with dashes.
export function parseManifestCaption(text) {
  const lines = String(text ?? '').split('\n')

  const name = marker(lines, '📄')
  const totals = marker(lines, '💾')
  const id = marker(lines, '🆔')
  const createdAt = marker(lines, '📅')

  // Every card telstore wrote before --note existed is a complete card, so the note is the
  // one marker whose absence means "there is no note" rather than "this is not a card".
  const note = marker(lines, '📝')

  if (!name || !totals || !id || !createdAt) return null

  const match = /^(.+) · (\d+) chunks?$/.exec(totals)

  if (!match) return null

  return { id, name, size: match[1], chunks: Number(match[2]), createdAt, note }
}
