import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_NOTE_LENGTH,
  MAX_HINT_LENGTH,
  chunkCaption,
  manifestCaption,
  parseManifestCaption,
  parseNote,
  parseHint,
  hasControlCharacter,
  terminalSafe,
} from '../src/caption.js'

test('a chunk caption names the backup and its position in the set', () => {
  assert.equal(chunkCaption({ id: 'telstore-20260905-7f3a91', number: 3, total: 12 }), '📦 telstore-20260905-7f3a91 · 3/12')
})

// restore finds the manifest with `search: backupId`, so every caption telstore
// writes has to keep the id searchable as one whole word.
test('a chunk caption keeps the backup id searchable', () => {
  const caption = chunkCaption({ id: 'telstore-20260905-7f3a91', number: 1, total: 1 })

  assert.match(caption, /(^|\s)telstore-20260905-7f3a91(\s|$)/)
})

test('a chunk from a stream is captioned without a total nobody knows yet', () => {
  assert.equal(chunkCaption({ id: 'telstore-1', number: 3, total: null }), '📦 telstore-1 · 3')
})

test('a chunk from a file still carries its total', () => {
  assert.equal(chunkCaption({ id: 'telstore-1', number: 3, total: 12 }), '📦 telstore-1 · 3/12')
})

test('a manifest caption is a summary card of the whole backup', () => {
  const caption = manifestCaption({
    id: 'telstore-20260905-7f3a91',
    name: 'data.tar',
    size: 22_998_546_842,
    chunks: 12,
    createdAt: '2026-09-05T16:40:12.000Z',
  })

  assert.equal(
    caption,
    [
      '📄 data.tar',
      '💾 21.4 GB · 12 chunks',
      '🆔 telstore-20260905-7f3a91',
      '📅 2026-09-05 16:40 UTC',
      '',
      '↩ npx telstore restore telstore-20260905-7f3a91',
      '#telstore',
    ].join('\n'),
  )
})

test('a manifest caption counts a single chunk in the singular', () => {
  const caption = manifestCaption({
    id: 'telstore-20260901-9de447',
    name: 'photos.zip',
    size: 1024,
    chunks: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
  })

  assert.match(caption, /· 1 chunk$/m)
})

// A file name may legally contain a newline. Written straight into the caption it
// would push every following line one row down and break the card apart.
test('a manifest caption flattens line breaks in the file name', () => {
  const caption = manifestCaption({
    id: 'telstore-20260905-7f3a91',
    name: 'two\nlines.tar',
    size: 1024,
    chunks: 1,
    createdAt: '2026-09-05T16:40:12.000Z',
  })

  assert.equal(caption.split('\n')[0], '📄 two lines.tar')
  assert.equal(caption.split('\n').length, 7)
})

test('a manifest caption parses back into the fields it was built from', () => {
  const built = manifestCaption({
    id: 'telstore-20260905-7f3a91',
    name: 'data.tar',
    size: 22_998_546_842,
    chunks: 12,
    createdAt: '2026-09-05T16:40:12.000Z',
  })

  assert.deepEqual(parseManifestCaption(built), {
    id: 'telstore-20260905-7f3a91',
    name: 'data.tar',
    size: '21.4 GB',
    chunks: 12,
    createdAt: '2026-09-05 16:40 UTC',
    note: null,
    encrypted: false,
    hint: null,
  })
})

// Backups uploaded by earlier versions carry "#telstore <id> manifest" and nothing else.
// list still has to show them, so parsing has to say "I don't know" rather than guess.
test('a caption from an older release parses as unknown', () => {
  assert.equal(parseManifestCaption('#telstore telstore-20260905-7f3a91 manifest'), null)
})

test('an unrelated message parses as unknown', () => {
  assert.equal(parseManifestCaption('here are my holiday photos'), null)
})

test('a card someone edited down to nothing parses as unknown', () => {
  assert.equal(parseManifestCaption('📄 data.tar\n#telstore'), null)
})

// A note is typed by a person at a shell prompt, and everything downstream of here — the
// manifest body and the card in the chat — has to be handed the same string, so it is
// normalised once, in one place, rather than twice into two slightly different notes.
test('a note is trimmed and folded onto one line', () => {
  assert.equal(parseNote('  before   the\nmove  '), 'before the move')
})

test('no note at all is not a note', () => {
  assert.equal(parseNote(undefined), null)
})

// Typing --note "" is somebody meaning to say something, and an empty caption line that
// says nothing is worse than being asked to type it again.
test('a note of nothing but whitespace is refused', () => {
  assert.throws(() => parseNote('   '), /--note is empty/)
})

// Telegram caps a caption at 1024 characters and the card already spends some of them, so
// a note past the limit would come back as a rejected send — or, worse, a silently cut one.
test('a note longer than the limit is refused rather than cut short', () => {
  assert.throws(() => parseNote('x'.repeat(MAX_NOTE_LENGTH + 1)), /501 characters/)
})

test('a note exactly at the limit is kept whole', () => {
  assert.equal(parseNote('x'.repeat(MAX_NOTE_LENGTH)).length, MAX_NOTE_LENGTH)
})

test('a manifest caption carries the note under the date', () => {
  const caption = manifestCaption({
    id: 'telstore-20260905-7f3a91',
    name: 'data.tar',
    size: 1024,
    chunks: 1,
    createdAt: '2026-09-05T16:40:12.000Z',
    note: 'quarterly accounts, keep until 2030',
  })

  assert.equal(
    caption,
    [
      '📄 data.tar',
      '💾 1.0 KB · 1 chunk',
      '🆔 telstore-20260905-7f3a91',
      '📅 2026-09-05 16:40 UTC',
      '📝 quarterly accounts, keep until 2030',
      '',
      '↩ npx telstore restore telstore-20260905-7f3a91',
      '#telstore',
    ].join('\n'),
  )
})

// The note is optional and always was: a card without one must look exactly like every card
// telstore wrote before the flag existed, or list would start reading old backups differently.
test('a manifest caption without a note has no line for one', () => {
  const caption = manifestCaption({
    id: 'telstore-20260905-7f3a91',
    name: 'data.tar',
    size: 1024,
    chunks: 1,
    createdAt: '2026-09-05T16:40:12.000Z',
  })

  assert.equal(caption.includes('📝'), false)
  assert.equal(caption.split('\n').length, 7)
})

test('a card with a note parses the note back out', () => {
  const built = manifestCaption({
    id: 'telstore-20260905-7f3a91',
    name: 'data.tar',
    size: 1024,
    chunks: 1,
    createdAt: '2026-09-05T16:40:12.000Z',
    note: 'quarterly accounts',
  })

  assert.equal(parseManifestCaption(built).note, 'quarterly accounts')
})

// Backups made before --note existed are the majority, and they are not half-read cards:
// the note is the one field a complete card is allowed to be missing.
test('a card without a note parses with no note rather than as unknown', () => {
  const built = manifestCaption({
    id: 'telstore-20260905-7f3a91',
    name: 'data.tar',
    size: 1024,
    chunks: 1,
    createdAt: '2026-09-05T16:40:12.000Z',
  })

  assert.equal(parseManifestCaption(built).note, null)
})

test('an encrypted card says so and carries the hint, and parses back', () => {
  const caption = manifestCaption({
    id: 'telstore-20260914-ab12cd',
    name: 'data.tar',
    size: 1000,
    chunks: 1,
    createdAt: '2026-09-14T08:00:00.000Z',
    encrypted: true,
    hint: 'the cat',
  })

  assert.match(caption, /\n🔒 encrypted\n💡 the cat\n/)

  const card = parseManifestCaption(caption)
  assert.equal(card.encrypted, true)
  assert.equal(card.hint, 'the cat')
})

test('a plain card is unchanged and parses as not encrypted', () => {
  const caption = manifestCaption({
    id: 'telstore-20260914-ab12cd',
    name: 'data.tar',
    size: 1000,
    chunks: 1,
    createdAt: '2026-09-14T08:00:00.000Z',
  })

  assert.equal(caption.includes('🔒'), false)
  assert.equal(parseManifestCaption(caption).encrypted, false)
  assert.equal(parseManifestCaption(caption).hint, null)
})

// Telegram takes 1024 characters in a caption. This is the worst card telstore can write.
test('the longest card with a lock and the longest hint still fits a caption', () => {
  const caption = manifestCaption({
    id: 'telstore-20260914-abcdef',
    name: 'x'.repeat(255),
    size: 19.9e12,
    chunks: 10000,
    createdAt: '2026-09-14T08:00:00.000Z',
    note: 'n'.repeat(500),
    encrypted: true,
    hint: 'h'.repeat(MAX_HINT_LENGTH),
  })

  assert.ok(caption.length <= 1024, `${caption.length} characters`)
})

test('a hint is folded onto one line, and an empty one is no hint', () => {
  assert.equal(parseHint('  the\n cat  '), 'the cat')
  assert.equal(parseHint('   '), null)
  assert.equal(parseHint(undefined), null)
})

test('a hint longer than the card has room for is refused, not cut', () => {
  assert.throws(() => parseHint('h'.repeat(MAX_HINT_LENGTH + 1)), /room for 100/)
})

// A hint is printed before the seal over it can be checked, so what reaches the terminal must
// be text and nothing else: an escape sequence from a tampered manifest could clear the screen
// around the password prompt.
test('terminalSafe drops C0 and C1 control characters and folds whitespace', () => {
  assert.equal(terminalSafe('the\x1b[2J cat'), 'the[2J cat')
  assert.equal(terminalSafe('a\x00b\x07c\x7fd\x9be\x85f'), 'abcdef')
  assert.equal(terminalSafe('  the\t\n cat\r  '), 'the cat')
  assert.equal(terminalSafe('the cat'), 'the cat')
  assert.equal(hasControlCharacter(terminalSafe('\x1b\x9b\x00\x1f\x7f\x80\x9f x')), false)
})

test('hasControlCharacter finds C0, DEL and C1, and nothing else', () => {
  for (const c of ['\x00', '\x1b', '\x1f', '\x7f', '\x80', '\x9f', '\n', '\t']) {
    assert.equal(hasControlCharacter(`a${c}b`), true, JSON.stringify(c))
  }

  assert.equal(hasControlCharacter('the cat · 💡 é'), false)
})

// parseManifest refuses a hint carrying a control character, so one typed at upload time has to
// lose it here — otherwise an honest backup would be one restore turns away.
test('a hint typed with a control character in it loses the character', () => {
  const hint = parseHint('the\x1b[2J cat\x07')

  assert.equal(hint, 'the[2J cat')
  assert.equal(hasControlCharacter(hint), false)
})

test('a hint that contains the password is refused', () => {
  assert.throws(() => parseHint('it is Hunter2 obviously', 'hunter2'), /contains the password/)
  assert.equal(parseHint('my cat', 'hunter2'), 'my cat')
})
