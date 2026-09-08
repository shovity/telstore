import { parseManifestCaption } from '../caption.js'
import { chatName, describeChat } from '../chat.js'
import {
  closeQuietly,
  connect as realConnect,
  iterDocuments,
  iterManifestSearch,
} from '../client.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import { MANIFEST_SUFFIX } from '../manifest.js'
import { assertLoggedIn } from '../session.js'
import { requireChat, resolveSettings } from '../settings.js'

const UNKNOWN = '—'
const GAP = '  '

const COLUMNS = [
  { header: 'BACKUP ID', key: 'id' },
  { header: 'FILE', key: 'name' },
  { header: 'SIZE', key: 'size', right: true },
  { header: 'CHUNKS', key: 'chunks', right: true },
  { header: 'CREATED', key: 'created' },
  { header: 'NOTE', key: 'note' },
]

// The table is read at a glance, and the note is the one field with no shape at all — 500
// characters of it would push every column off the side. The whole note is still in the
// manifest and on the card in the chat, which is where anyone reading it properly will look.
const NOTE_WIDTH = 40

function shorten(note) {
  return note.length > NOTE_WIDTH ? `${note.slice(0, NOTE_WIDTH - 1)}…` : note
}

// What list has to read through depends on how big the backups are, not how many there are:
// it walks from the newest message down and stops the moment it has --limit manifests, so the
// three thousandth backup in a chat costs nothing because it is never reached. What costs is
// the chunks in between — one message each — which is why the ceiling is a budget per backup
// asked for rather than one number for every chat.
//
// 60 documents per backup covers a backup of about 105GB at the default chunk size. A fixed
// 1000 was both too tight and too loose at once: twenty backups of 100GB need 1140 documents
// and got 1000 of them, while `--limit 5` never needed more than 300.
export const DOCUMENTS_PER_BACKUP = 60

// A search result is already a manifest, so it buys far more backups per document read. Its
// budget only has to cover what matchesTerm throws away — measured 2026-09-08, a term like
// "2026-09" comes back matching everything and is then cut down to the month asked for.
export const RESULTS_PER_BACKUP = 20

// --limit takes any whole number, so the budget needs an end of its own: without one,
// `--limit 100000` would ask for six million documents and sixty thousand requests.
export const MAX_LIST_DOCUMENTS = 10000

export function documentBudget(limit, perBackup) {
  return Math.min(limit * perBackup, MAX_LIST_DOCUMENTS)
}

// Stopping at the ceiling used to leave the reader standing there: "there may be older backups
// further back" is true and offers nothing to do about it. --search reaches them without
// reading the chunks in between, which is the whole reason it exists.
const DEEPER_HINT =
  '"npx telstore list --search <text>" reaches older ones without reading every chunk ' +
  'in between.'

// Telegram matches whole words and nothing shorter: measured 2026-09-08, "projex" found
// projex.zip while "proj", "pro" and "pr" each found nothing at all. That is the one way a
// search can come back empty over a backup that is plainly there, so the empty answer says
// it, and points at the listing that never asks the index.
const SEARCH_MISS_HELP =
  'Telegram matches whole words: "projex" finds projex.zip, "proj" does not. ' +
  'Run "npx telstore list" without --search to see every backup without going through ' +
  'the search index.'

function backupIdFromFileName(fileName) {
  return fileName.slice(0, -MANIFEST_SUFFIX.length)
}

function utcDay(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

// The card is text in a chat, which means a person can edit or predate it. The id is the
// one field restore cannot be wrong about, so it always comes from the file name telstore
// wrote; the caption only decorates. A card that cannot be read back leaves the rest
// unknown, because inventing it would describe a backup that does not exist.
function toRow(message) {
  const id = backupIdFromFileName(message.fileName)
  const card = parseManifestCaption(message.caption)

  if (!card) {
    return {
      id,
      name: UNKNOWN,
      size: UNKNOWN,
      chunks: UNKNOWN,
      created: utcDay(message.date),
      note: UNKNOWN,
    }
  }

  return {
    id,
    name: card.name,
    size: card.size,
    chunks: String(card.chunks),
    created: card.createdAt.slice(0, 10),
    note: card.note ? shorten(card.note) : UNKNOWN,
  }
}

// A search term is a question about one run, and an empty one is not a question: answering
// it with every backup would look exactly like a search that matched everything.
function parseSearchTerm(raw) {
  if (raw === undefined || raw === null) return null

  const term = String(raw).trim()

  if (term === '') {
    throw new Error(
      '--search is empty. Write the word to look for, or leave the flag off — "list" ' +
        'without it shows every backup.',
    )
  }

  return term
}

// The four fields a person remembers about a backup, and the whole of what --search compares
// against. The note is matched entire rather than the 40 characters the table has room for:
// a word that fell off the end of the column is still a word they typed. A card that cannot
// be read back leaves only what the message itself knows.
function searchableFields(message) {
  const id = backupIdFromFileName(message.fileName)
  const card = parseManifestCaption(message.caption)

  if (!card) return [id, utcDay(message.date)]

  return [id, card.name, card.note ?? '', card.createdAt.slice(0, 10)]
}

// Telegram decides what comes back; this decides what is true. The index answers a term the
// way it wants to — measured 2026-09-08, "2026-09" returned every document in the chat — so
// a hit is shown only if the term really is in one of the fields above. Without this pass a
// search for a month would list backups from every other month, which is the plausible wrong
// answer this project exists to refuse.
function matchesTerm(message, term) {
  return searchableFields(message).some((field) => field.toLowerCase().includes(term))
}

// A walk of one page is over in about the time it takes to notice — 165ms against a real
// chat — and that is the usual case, so nothing is drawn for the first stretch: a line that
// appears and is wiped in the same breath is a flicker, not information. Past that the read
// is long enough that silence reads as the hang this project refuses everywhere else.
//
// \r only moves the cursor home, so every line is padded to the widest one drawn and the last
// write wipes the row: the table that follows must never land on half a progress line.
const NOTICE_QUIET_MS = 400
const NOTICE_INTERVAL_MS = 200

function createWalkNotice({ write, now, quietMs = NOTICE_QUIET_MS, intervalMs = NOTICE_INTERVAL_MS }) {
  const startedAt = now()
  let lastDrawnAt = 0
  let widest = 0

  return {
    tick(text) {
      if (now() - startedAt < quietMs) return
      if (lastDrawnAt !== 0 && now() - lastDrawnAt < intervalMs) return

      lastDrawnAt = now()
      widest = Math.max(widest, text.length)
      write(`\r${text.padEnd(widest)}`)
    },
    clear() {
      if (widest === 0) return
      write(`\r${' '.repeat(widest)}\r`)
    },
  }
}

function renderTable(rows) {
  // Most people never write a note, and a column of dashes tells them nothing they did not
  // already know while costing every other column the width it takes.
  const columns = COLUMNS.filter(
    (column) => column.key !== 'note' || rows.some((row) => row.note !== UNKNOWN),
  )

  const widths = columns.map((column) =>
    Math.max(column.header.length, ...rows.map((row) => row[column.key].length)),
  )

  const line = (cells) =>
    cells
      .map((cell, i) => (columns[i].right ? cell.padStart(widths[i]) : cell.padEnd(widths[i])))
      .join(GAP)
      .trimEnd()

  return [
    line(columns.map((column) => column.header)),
    ...rows.map((row) => line(columns.map((column) => row[column.key]))),
  ]
}

export async function runList(options = {}, deps = {}) {
  const {
    configDir = defaultConfigDir(),
    connect = realConnect,
    disconnect = (client) => client.destroy(),
    readDocuments = iterDocuments,
    searchManifests = iterManifestSearch,
    log = (line) => console.log(line),
    // The notice is drawn on stderr, and only onto a terminal: unlike an upload's progress
    // bar, `list` is a command people pipe into grep, and a carriage return in a log file is
    // rubbish. Null means draw nothing at all.
    writeProgress = process.stderr.isTTY ? (text) => process.stderr.write(text) : null,
    now = () => Date.now(),
  } = deps

  const config = await loadConfig(configDir)
  const { values: settings } = resolveSettings(options, config, { file: configFile(configDir) })
  // Before the login gate: a bad term is the user's own typing, and telling them to log in
  // first would send them off after the wrong thing.
  const term = parseSearchTerm(options.search)
  // Ask about the login before the destination: telling someone who has never logged in
  // to pick a chat sends them off after the wrong thing.
  assertLoggedIn(config)
  const chat = requireChat(settings)

  const client = await connect(config, { verbose: settings.verbose })

  // Walked rather than searched, unless a term was given. Telegram's text index can answer
  // nothing at all about a chat that is full of backups — it did for a whole day in a channel
  // that had just been created — and "No backups found" is a sentence someone acts on. The
  // documents themselves were right every time they were asked for.
  //
  // --search is the one place worth paying the index for: a term matches a backup that may be
  // ten thousand messages back, and walking to it would cost a request per hundred documents
  // in between, every time, for as long as the chat keeps growing. So the search narrows and
  // matchesTerm decides — the index is asked where to look, never what is true.
  const found = []
  let read = 0

  const unit = term ? 'search results' : 'documents'
  const budget = documentBudget(settings.limit, term ? RESULTS_PER_BACKUP : DOCUMENTS_PER_BACKUP)

  const results = term
    ? searchManifests(client, chat, term, { max: budget })
    : readDocuments(client, chat, { max: budget })

  const wanted = term === null ? null : term.toLowerCase()
  const notice = writeProgress ? createWalkNotice({ write: writeProgress, now }) : null

  try {
    for await (const document of results) {
      read += 1

      notice?.tick(
        `Reading ${chatName(chat)}… ${read} ${unit}, ${found.length} backup` +
          `${found.length === 1 ? '' : 's'}`,
      )

      if (!document.fileName?.endsWith(MANIFEST_SUFFIX)) continue
      if (wanted !== null && !matchesTerm(document, wanted)) continue

      found.push(document)

      // Everything past here is older than the twentieth newest backup, and nobody asked
      // for it. In a chat of ten thousand chunks this is the difference between one
      // request and ten.
      if (found.length >= settings.limit) break
    }
  } finally {
    notice?.clear()
    await closeQuietly(client, disconnect)
  }

  // The one thing either reader cannot see is what lies past its own ceiling, so anything it
  // says about the whole chat has to stop at the edge of what it read.
  const capped = found.length < settings.limit && read >= budget

  log(`Destination  ${describeChat(chat)}`)
  if (term) log(`Search       ${JSON.stringify(term)}`)
  log('')

  const rows = found.map(toRow)

  if (rows.length === 0) {
    if (term) {
      log(
        capped
          ? `No backups matching ${JSON.stringify(term)} in the newest ${budget} ` +
              `${unit} from ${chatName(chat)}. There may be older ones further back.`
          : `No backups matching ${JSON.stringify(term)} in ${chatName(chat)}.`,
      )
      log(SEARCH_MISS_HELP)
      return rows
    }

    log(
      capped
        ? `No backups in the newest ${budget} ${unit} of ${chatName(chat)}. ` +
            `There may be older ones further back. ${DEEPER_HINT}`
        : `No backups found in ${chatName(chat)}. Upload one with: npx telstore <file>`,
    )
    return rows
  }

  for (const line of renderTable(rows)) log(line)

  log('')
  log(
    `${rows.length} backup${rows.length === 1 ? '' : 's'}` +
      `${term ? ` matching ${JSON.stringify(term)}` : ''}. ` +
      'Restore with: npx telstore restore <backup-id>',
  )

  if (capped) {
    log(
      `Read the newest ${budget} ${unit} in ${chatName(chat)} to find them — ` +
        `there may be older ${term ? 'matches' : 'backups'} further back.` +
        `${term ? '' : ` ${DEEPER_HINT}`}`,
    )
  }

  return rows
}
