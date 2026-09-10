import test from 'node:test'
import assert from 'node:assert/strict'

import {
  backupIdDay,
  isChunkFileName,
  newBackupId,
  chunkFileName,
  manifestFileName,
  buildManifest,
  serializeManifest,
  parseManifest,
  parseManifestJson,
  manifestMessageIds,
} from '../src/manifest.js'

function sampleChunks() {
  return [
    { i: 0, msgId: 1234, size: 40, sha256: 'a3f1' },
    { i: 1, msgId: 1235, size: 40, sha256: '9c20' },
    { i: 2, msgId: 1236, size: 20, sha256: '77bb' },
  ]
}

function sampleManifest(overrides = {}) {
  return buildManifest({
    id: 'telstore-20260905-7f3a91',
    name: 'data.tar',
    size: 100,
    chunkSize: 40,
    chunks: sampleChunks(),
    createdAt: '2026-09-05T07:40:12.000Z',
    ...overrides,
  })
}

test('newBackupId follows the telstore-YYYYMMDD-hex shape', () => {
  const id = newBackupId(new Date('2026-09-05T07:40:12.000Z'), () => '7f3a91')
  assert.equal(id, 'telstore-20260905-7f3a91')
})

test('newBackupId is genuinely random and well formed', () => {
  const a = newBackupId()
  const b = newBackupId()
  assert.match(a, /^telstore-\d{8}-[0-9a-f]{6}$/)
  assert.notEqual(a, b)
})

test('chunkFileName numbers from 1 and pads to four digits', () => {
  assert.equal(chunkFileName('telstore-1', 0), 'telstore-1.part0001')
  assert.equal(chunkFileName('telstore-1', 41), 'telstore-1.part0042')
  assert.equal(chunkFileName('telstore-1', 1233), 'telstore-1.part1234')
})

test('manifestFileName ends in .manifest.json', () => {
  assert.equal(manifestFileName('telstore-1'), 'telstore-1.manifest.json')
})

test('buildManifest stamps version 1 and orders the chunks', () => {
  const m = buildManifest({
    id: 'telstore-1',
    name: 'data.tar',
    size: 100,
    chunkSize: 40,
    chunks: [sampleChunks()[2], sampleChunks()[0], sampleChunks()[1]],
    createdAt: '2026-09-05T07:40:12.000Z',
  })

  assert.equal(m.v, 1)
  assert.deepEqual(m.chunks.map((c) => c.i), [0, 1, 2])
})

test('serialize then parse returns the original manifest', () => {
  const m = sampleManifest()
  assert.deepEqual(parseManifest(serializeManifest(m)), m)
})

test('parseManifest accepts both a string and a Buffer', () => {
  const m = sampleManifest()
  assert.deepEqual(parseManifest(serializeManifest(m).toString('utf8')), m)
})

test('parseManifest rejects an unknown version', () => {
  const m = { ...sampleManifest(), v: 2 }
  assert.throws(() => parseManifest(JSON.stringify(m)), /version/)
})

test('parseManifest detects a missing chunk', () => {
  const m = sampleManifest()
  m.chunks = m.chunks.slice(0, 2)
  assert.throws(() => parseManifest(JSON.stringify(m)), /missing/)
})

test('parseManifest detects a mismatched total size', () => {
  const m = sampleManifest()
  m.chunks[0].size = 39
  assert.throws(() => parseManifest(JSON.stringify(m)), /add up to/)
})

test('parseManifest rejects broken JSON', () => {
  assert.throws(() => parseManifest('{ broken'), /not valid JSON/)
})

test('parseManifest catches a skewed chunk layout even when the total is right', () => {
  // 1000 bytes at chunkSize 400 must be [400, 400, 200]. The set [200, 400, 400] has
  // the right total, the right count, contiguous i and matching per-chunk sha256 —
  // but restore writes chunk i at offset i*400, producing a 1200-byte file with a hole.
  const m = buildManifest({
    id: 'telstore-1',
    name: 'data.tar',
    size: 1000,
    chunkSize: 400,
    chunks: [
      { i: 0, msgId: 1, size: 200, sha256: 'a' },
      { i: 1, msgId: 2, size: 400, sha256: 'b' },
      { i: 2, msgId: 3, size: 400, sha256: 'c' },
    ],
    createdAt: '2026-09-05T07:40:12.000Z',
  })

  assert.throws(() => parseManifest(JSON.stringify(m)), /records 200 bytes for chunk 1.*400 bytes/s)
})

test('parseManifest catches a last chunk longer than the remainder', () => {
  const m = buildManifest({
    id: 'telstore-1',
    name: 'data.tar',
    size: 100,
    chunkSize: 40,
    chunks: [
      { i: 0, msgId: 1, size: 30, sha256: 'a' },
      { i: 1, msgId: 2, size: 30, sha256: 'b' },
      { i: 2, msgId: 3, size: 40, sha256: 'c' },
    ],
    createdAt: '2026-09-05T07:40:12.000Z',
  })

  assert.throws(() => parseManifest(JSON.stringify(m)), /wrong chunk positions/)
})

test('parseManifest accepts a correct uniform layout', () => {
  const m = buildManifest({
    id: 'telstore-1',
    name: 'data.tar',
    size: 1000,
    chunkSize: 400,
    chunks: [
      { i: 0, msgId: 1, size: 400, sha256: 'a' },
      { i: 1, msgId: 2, size: 400, sha256: 'b' },
      { i: 2, msgId: 3, size: 200, sha256: 'c' },
    ],
    createdAt: '2026-09-05T07:40:12.000Z',
  })

  assert.deepEqual(parseManifest(JSON.stringify(m)), m)
})

// The manifest is downloaded from a chat, so it is untrusted input. Every rejection has to
// name what is actually wrong with it: a raw TypeError tells the user their file is broken
// in a way only a developer can read.
test('parseManifest names a chunk entry that is not an object', () => {
  const text = JSON.stringify({
    v: 1,
    id: 'x',
    name: 'n',
    size: 100,
    chunkSize: 50,
    chunks: [{ i: 0, msgId: 1, size: 50, sha256: 'a' }, null],
  })

  assert.throws(() => parseManifest(text), /chunk 2 .*not|entry 2|is not an object/i)
})

// The old code compared a numeric total against a string size with !==, so it rejected the
// manifest — but the message read "Chunk sizes add up to 100, but the manifest records a
// file size of 100", which sends the reader hunting for a difference that is not there.
test('parseManifest says the size is the wrong type rather than printing it twice', () => {
  const text = JSON.stringify({
    v: 1,
    id: 'x',
    name: 'n',
    size: '100',
    chunkSize: 50,
    chunks: [
      { i: 0, msgId: 1, size: 50, sha256: 'a' },
      { i: 1, msgId: 2, size: 50, sha256: 'b' },
    ],
  })

  assert.throws(() => parseManifest(text), /whole number/)
})

test('parseManifest rejects a chunk size that is not a whole number', () => {
  const text = JSON.stringify({
    v: 1,
    id: 'x',
    name: 'n',
    size: 100,
    chunkSize: 0,
    chunks: [{ i: 0, msgId: 1, size: 100, sha256: 'a' }],
  })

  assert.throws(() => parseManifest(text), /whole number/)
})

test('parseManifestJson reads a manifest body without judging what is in it', () => {
  assert.deepEqual(parseManifestJson(Buffer.from('{"v":9,"chunks":[]}')), { v: 9, chunks: [] })
})

test('parseManifestJson refuses content that is not JSON', () => {
  assert.throws(() => parseManifestJson('{ not json'), /not valid JSON/)
})

// The test that proves delete does not go through parseManifest. A manifest whose layout
// is wrong is exactly the broken backup somebody wants gone; refusing to read its message
// ids would leave the only way out through the Telegram app.
test('manifestMessageIds reads a manifest that parseManifest would refuse', () => {
  const broken = { v: 2, size: 999, chunkSize: 1, chunks: [{ i: 0, msgId: 10, size: 7 }] }

  assert.throws(() => parseManifest(JSON.stringify(broken)))
  assert.deepEqual(manifestMessageIds(broken), [10])
})

test('manifestMessageIds returns the ids in the order the manifest lists them', () => {
  const manifest = { chunks: [{ msgId: 10 }, { msgId: 12 }, { msgId: 11 }] }

  assert.deepEqual(manifestMessageIds(manifest), [10, 12, 11])
})

test('manifestMessageIds refuses a manifest with no chunk list', () => {
  assert.throws(() => manifestMessageIds({ chunks: [] }), /cannot say which messages/)
  assert.throws(() => manifestMessageIds({}), /cannot say which messages/)
  assert.throws(() => manifestMessageIds({ chunks: 'nope' }), /cannot say which messages/)
})

// Which message to destroy is the one number nobody may guess at. A manifest that cannot
// say it exactly is refused whole, rather than half-deleted and then left without the list
// that names the rest.
test('manifestMessageIds refuses an id that is not a message id', () => {
  for (const msgId of [null, undefined, '12', 0, -3, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(
      () => manifestMessageIds({ chunks: [{ msgId: 10 }, { msgId }] }),
      /chunk 2/,
      `expected ${JSON.stringify(msgId)} to be refused`,
    )
  }
})

test('manifestMessageIds refuses a chunk entry that is not an object', () => {
  assert.throws(() => manifestMessageIds({ chunks: [null] }), /chunk 1/)
})

test('buildManifest records the note it was given', () => {
  assert.equal(sampleManifest({ note: 'quarterly accounts' }).note, 'quarterly accounts')
})

// A manifest without a note has to be byte-identical to one written before the flag existed,
// or every backup made since would look like a different format to an older telstore.
test('buildManifest leaves the note out entirely when there is none', () => {
  assert.equal('note' in sampleManifest(), false)
})

test('parseManifest accepts a manifest carrying a note', () => {
  const manifest = parseManifest(serializeManifest(sampleManifest({ note: 'keep until 2030' })))
  assert.equal(manifest.note, 'keep until 2030')
})

// The manifest comes off a chat, where a person can edit the file and send it back. The note
// is only ever shown, never computed with, but a field that is not what it claims to be is
// the one thing this project refuses to shrug at.
test('parseManifest refuses a note that is not text', () => {
  const manifest = { ...sampleManifest(), note: { was: 'an object' } }

  assert.throws(() => parseManifest(serializeManifest(manifest)), /note/)
})

// --- recognising a backup's own documents in a chat --------------------------------------

// delete walks the chat to find chunks nothing on this machine names, and the only thing
// that says which backup a document belongs to is the file name telstore wrote on it. A
// reader that disagreed with the writer by one character would find nothing at all.
test('isChunkFileName accepts every name chunkFileName writes', () => {
  const id = 'telstore-20260905-7f3a91'

  for (const i of [0, 1, 9, 99, 998, 9999, 12345]) {
    assert.equal(isChunkFileName(id, chunkFileName(id, i)), true, `chunk ${i}`)
  }
})

test('isChunkFileName does not take a manifest for a chunk', () => {
  const id = 'telstore-20260905-7f3a91'

  assert.equal(isChunkFileName(id, manifestFileName(id)), false)
})

// The names below are ones telstore never writes, and every one of them would be destroyed
// with the backup if the prefix alone decided. A person uploads what they like into their
// own chat, and `<id>.partial` is a name this project itself uses for something else.
test('isChunkFileName refuses a name that only starts like a chunk', () => {
  const id = 'telstore-20260905-7f3a91'

  for (const name of [
    `${id}.partial`,
    `${id}.part`,
    `${id}.part0001.bak`,
    `${id}.part 1`,
    `${id}.part-1`,
    `${id}.manifest.json`,
    id,
  ]) {
    assert.equal(isChunkFileName(id, name), false, name)
  }
})

test('isChunkFileName does not claim another backup\'s chunk', () => {
  const mine = 'telstore-20260905-7f3a91'
  const theirs = 'telstore-20260905-000000'

  assert.equal(isChunkFileName(mine, chunkFileName(theirs, 0)), false)
})

// A document Telegram hands over with no file name at all — a photo, a message that is not a
// document — must not throw its way out of a walk that is looking for chunks.
test('isChunkFileName answers no for a name that is not a string', () => {
  const id = 'telstore-20260905-7f3a91'

  for (const name of [null, undefined, 12, {}]) assert.equal(isChunkFileName(id, name), false)
})

// --- the day a backup id carries ---------------------------------------------------------

test('backupIdDay reads the day out of a backup id as the UTC second it began', () => {
  assert.equal(backupIdDay('telstore-20260905-7f3a91'), Date.UTC(2026, 8, 5) / 1000)
})

// The one reader of this uses it as a floor for a walk of somebody's chat, so a date that
// rolls over into next year would read as a floor above everything there and stop the walk
// before it started — an early stop nobody would ever see.
test('backupIdDay refuses a date that does not exist rather than rolling it over', () => {
  assert.equal(backupIdDay('telstore-20261345-7f3a91'), null)
  assert.equal(backupIdDay('telstore-20260231-7f3a91'), null)
})

test('backupIdDay refuses an id telstore did not mint', () => {
  for (const id of ['backup-1', 'telstore-2026-7f3a91', 'telstore-20260905', '']) {
    assert.equal(backupIdDay(id), null, id)
  }
})

test('backupIdDay reads the id newBackupId writes', () => {
  const at = new Date(Date.UTC(2026, 8, 5, 13, 20))

  assert.equal(backupIdDay(newBackupId(at, () => 'abc123')), Date.UTC(2026, 8, 5) / 1000)
})
