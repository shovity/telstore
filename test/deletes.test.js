import test from 'node:test'
import assert from 'node:assert/strict'

import { runDeletes } from '../src/commands/delete.js'
import { saveConfig } from '../src/config.js'
import { buildManifest, manifestFileName, serializeManifest } from '../src/manifest.js'
import { LOGGED_IN, collect, tempDir } from './helpers.js'

// A chat holding several finished backups, each with its own chunks and its own manifest.
function fakeChat(count) {
  const backups = []

  for (let n = 0; n < count; n += 1) {
    const id = `telstore-2026090${n + 1}-00000${n + 1}`
    const chunkIds = [1000 + n * 10, 1001 + n * 10]
    const manifestMsgId = 2000 + n

    backups.push({
      id,
      name: `data-${n}.tar`,
      chunkIds,
      manifestMsgId,
      bytes: serializeManifest(
        buildManifest({
          id,
          name: `data-${n}.tar`,
          size: 800,
          chunkSize: 400,
          chunks: chunkIds.map((msgId, i) => ({ i, msgId, size: 400, sha256: 'a'.repeat(64) })),
        }),
      ),
    })
  }

  return { backups, ids: backups.map((b) => b.id) }
}

async function workspace() {
  const configDir = await tempDir('deletes')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@store' } }, configDir)
  return configDir
}

function deps(chat, configDir, { hidden = [], failOn = [], ...extra } = {}) {
  const calls = []
  const visible = chat.backups.filter((b) => !hidden.includes(b.id))

  return {
    calls,
    configDir,
    log: () => {},
    writeErr: () => {},
    connect: async () => ({}),
    disconnect: async () => {},
    confirm: async () => true,
    interactive: () => true,
    retryOptions: { attempts: 1 },
    readDocuments: async function* () {},
    writeProgress: null,
    searchManifest: async (client, peer, query) => {
      const backup = visible.find((b) => b.id === query)
      return backup ? { id: backup.manifestMsgId, fileName: manifestFileName(query) } : null
    },
    readMessageBytes: async (client, message) =>
      chat.backups.find((b) => b.manifestMsgId === message.id).bytes,
    deleteMessages: async (client, peer, ids) => {
      const owner = chat.backups.find(
        (b) => b.chunkIds.includes(ids[0]) || b.manifestMsgId === ids[0],
      )

      if (owner && failOn.includes(owner.id)) throw new Error('server said no')

      calls.push([...ids])
      return ids.length
    },
    ...extra,
  }
}

test('every id given is deleted, its chunks before its manifest', async () => {
  const chat = fakeChat(2)
  const configDir = await workspace()
  const d = deps(chat, configDir)

  const { failed } = await runDeletes(chat.ids, {}, d)

  assert.equal(failed, 0)
  assert.deepEqual(d.calls, [[1000, 1001], [2000], [1010, 1011], [2001]])
})

test('a batch opens one connection and closes it once', async () => {
  const chat = fakeChat(3)
  const configDir = await workspace()
  let connects = 0
  let disconnects = 0

  await runDeletes(chat.ids, {}, {
    ...deps(chat, configDir),
    connect: async () => {
      connects += 1
      return {}
    },
    disconnect: async () => {
      disconnects += 1
    },
  })

  assert.equal(connects, 1)
  assert.equal(disconnects, 1)
})

test('one id asks the single-backup question and prints no batch list', async () => {
  const chat = fakeChat(1)
  const configDir = await workspace()
  const out = collect()
  const asked = []

  const { failed } = await runDeletes(chat.ids, {}, {
    ...deps(chat, configDir),
    log: out.log,
    confirm: async (question) => {
      asked.push(question)
      return true
    },
  })

  assert.equal(failed, 0)
  assert.equal(asked.length, 1)
  assert.match(asked[0], /Delete this backup from @store\?/)
  assert.doesNotMatch(out.text(), /Deleting 1 backup/)
})

test('the whole list is on screen before anything is destroyed, and asked about once', async () => {
  const chat = fakeChat(3)
  const configDir = await workspace()
  const out = collect()
  const asked = []
  const d = deps(chat, configDir)

  await runDeletes(chat.ids, {}, {
    ...d,
    log: out.log,
    confirm: async (question) => {
      asked.push(question)
      // Nothing may be gone by the time the question is asked.
      assert.deepEqual(d.calls, [])
      return true
    },
  })

  const text = out.text()
  assert.match(text, /Deleting 3 backups from .*@store/)
  assert.match(text, new RegExp(`${chat.ids[0]}\\s+data-0\\.tar`))
  assert.match(text, /800 B\s+2 chunks/)
  assert.equal(asked.length, 1)
  assert.match(asked[0], /cannot be recovered/)
  assert.match(asked[0], /Delete all 3\? \[y\/N\]/)
})

test('answering anything but yes destroys nothing', async () => {
  const chat = fakeChat(2)
  const configDir = await workspace()
  const d = deps(chat, configDir, { confirm: async () => false })

  await assert.rejects(() => runDeletes(chat.ids, {}, d), /Cancelled on request/)

  assert.deepEqual(d.calls, [])
})

test('--yes deletes the batch without asking anything', async () => {
  const chat = fakeChat(2)
  const configDir = await workspace()
  const d = deps(chat, configDir, {
    confirm: async () => {
      throw new Error('--yes must not ask')
    },
  })

  const { failed } = await runDeletes(chat.ids, { yes: true }, d)

  assert.equal(failed, 0)
})

test('an id nothing knows about refuses the whole batch, before the question', async () => {
  const chat = fakeChat(3)
  const configDir = await workspace()
  const d = deps(chat, configDir, {
    hidden: [chat.ids[1]],
    confirm: async () => {
      throw new Error('nothing may be asked once an id is unknown')
    },
  })

  await assert.rejects(() => runDeletes(chat.ids, {}, d), (err) => {
    assert.match(err.message, new RegExp(chat.ids[1]))
    assert.match(err.message, /no local record/)
    return true
  })

  assert.deepEqual(d.calls, [])
})

test('the same id twice is refused', async () => {
  const chat = fakeChat(1)
  const configDir = await workspace()
  const d = deps(chat, configDir)

  await assert.rejects(() => runDeletes([chat.ids[0], chat.ids[0]], {}, d), /named twice/)

  assert.deepEqual(d.calls, [])
})

test('a batch with no login is refused once, before any connection', async () => {
  const chat = fakeChat(2)
  const configDir = await tempDir('deletes-logged-out')
  await saveConfig({ settings: { chat: '@store' } }, configDir)
  let connects = 0

  await assert.rejects(
    () =>
      runDeletes(chat.ids, {}, {
        ...deps(chat, configDir),
        configDir,
        connect: async () => {
          connects += 1
          return {}
        },
      }),
    /Not logged in/,
  )

  assert.equal(connects, 0)
})

test('an id Telegram refuses does not stop the ones after it', async () => {
  const chat = fakeChat(3)
  const configDir = await workspace()
  const out = collect()
  const d = deps(chat, configDir, { failOn: [chat.ids[1]], log: out.log })

  const { results, failed } = await runDeletes(chat.ids, {}, d)

  assert.equal(failed, 1)
  assert.equal(results.length, 3)
  assert.match(results[1].error, /server said no/)
  assert.deepEqual(d.calls, [[1000, 1001], [2000], [1020, 1021], [2002]])

  const text = out.text()
  assert.match(text, /3 backups: 2 deleted, 1 failed\./)
  assert.match(text, new RegExp(`${chat.ids[1]}\\s+failed:`))
})

test('with no terminal to ask in, the batch stops and names the flag that goes on', async () => {
  const chat = fakeChat(2)
  const configDir = await workspace()
  const d = deps(chat, configDir, {
    interactive: () => false,
    confirm: async () => {
      throw new Error('nothing may be asked without a terminal')
    },
  })

  await assert.rejects(() => runDeletes(chat.ids, {}, d), /--yes/)

  assert.deepEqual(d.calls, [])
})

// A single delete walks the chat for chunks carrying the id, and finds them where nothing on
// this machine names them. A batch asks about every id at once, before anything is destroyed,
// and a walk apiece would turn one mistyped id into minutes of reading somebody's archive. It
// refuses instead — and says which of the two questions it actually asked.
test('a batch does not walk the chat for an id nothing names, and says so', async () => {
  const chat = fakeChat(2)
  const configDir = await workspace()
  const walks = []
  const d = deps(chat, configDir, {
    hidden: [chat.ids[1]],
    readDocuments: async function* () {
      walks.push(true)
    },
  })

  await assert.rejects(() => runDeletes(chat.ids, {}, d), (err) => {
    assert.match(err.message, /no manifest for it in @store/)
    assert.match(err.message, /Deleting one id on its own also reads the chat/)
    return true
  })

  assert.deepEqual(walks, [])
  assert.deepEqual(d.calls, [])
})
