import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatBytes,
  formatDuration,
  renderProgress,
  createProgress,
  renderStreamProgress,
  createStreamProgress,
} from '../src/progress.js'

// The same shape createProgress's own tests fake `now` with, but counting up by a full
// second each call so a throttle of the default 200ms is never in doubt.
function fakeClock() {
  let clock = -1000
  return () => {
    clock += 1000
    return clock
  }
}

test('formatBytes picks a sensible unit', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(1024 ** 2), '1.0 MB')
  assert.equal(formatBytes(1887436800), '1.8 GB')
  assert.equal(formatBytes(1024 ** 4), '1.0 TB')
})

test('formatBytes guards against a non-numeric size the way formatDuration does', () => {
  assert.equal(formatBytes('not-a-number'), '--')
  assert.equal(formatBytes(NaN), '--')
  assert.equal(formatBytes(undefined), '--')
  assert.equal(formatBytes(0), '0 B')
})

test('formatDuration is human readable', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(45), '45s')
  assert.equal(formatDuration(90), '1m30s')
  assert.equal(formatDuration(3661), '1h1m')
  assert.equal(formatDuration(Infinity), '--')
})

test('renderProgress shows the label, percentage, speed and ETA', () => {
  const line = renderProgress({
    done: 500 * 1024 * 1024,
    total: 1000 * 1024 * 1024,
    elapsedMs: 10_000,
    label: 'Chunk 1/3',
    width: 10,
  })

  assert.match(line, /Chunk 1\/3/)
  assert.match(line, /50%/)
  assert.match(line, /50\.0 MB\/s/)
  assert.match(line, /ETA 10s/)
})

test('renderProgress does not divide by zero before any time has passed', () => {
  const line = renderProgress({ done: 0, total: 100, elapsedMs: 0, label: 'x', width: 10 })
  assert.match(line, /0%/)
  assert.doesNotMatch(line, /NaN/)
})

test('renderProgress reports ETA 0s at 100%', () => {
  const line = renderProgress({ done: 100, total: 100, elapsedMs: 1000, label: 'x', width: 10 })
  assert.match(line, /100%/)
  assert.match(line, /ETA 0s/)
})

test('a stream line reports what was sent and how fast, and claims no percentage', () => {
  const line = renderStreamProgress({ done: 1024 * 1024, elapsedMs: 1000, label: 'Chunk 2' })
  assert.match(line, /Chunk 2/)
  assert.match(line, /1\.0 MB/)
  assert.match(line, /\/s/)
  assert.doesNotMatch(line, /%/)
  assert.doesNotMatch(line, /ETA/)
})

test('a stream bar pads a shrinking line so no tail of the last one survives', () => {
  const lines = []
  const bar = createStreamProgress({
    // A label that shrinks by more than thirty characters is what makes this test able to
    // fail: the unpadded render of the second line is genuinely shorter than the first, not
    // shorter by coincidence of how the byte counts happen to format.
    label: 'Uploading the archive to the backup chat',
    write: (l) => lines.push(l),
    now: fakeClock(),
  })
  bar.advance(1024 * 1024 * 1024)
  bar.setLabel('Chunk 2')
  bar.finish()

  const widths = lines.map((l) => l.replace(/^\r/, '').replace(/\n$/, '').length)

  // Sanity check on the fixture itself: without padding, the line drawn by setLabel would be
  // shorter than the one before it. If this ever stops being true the test has gone vacuous
  // again and the label needs to shrink by more.
  assert.ok(
    renderStreamProgress({ done: 1024 * 1024 * 1024, elapsedMs: 1000, label: 'Chunk 2' }).length <
      renderStreamProgress({
        done: 1024 * 1024 * 1024,
        elapsedMs: 1000,
        label: 'Uploading the archive to the backup chat',
      }).length,
    'the fixture must make the second line shorter than the first, unpadded',
  )

  assert.ok(widths.every((w) => w === Math.max(...widths)), 'every line is padded to the widest one drawn so far')
})

test('createProgress coalesces updates that arrive too close together', () => {
  const lines = []
  let clock = 0

  const progress = createProgress({
    total: 1000,
    label: 'Chunk 1/1',
    write: (line) => lines.push(line),
    now: () => clock,
    minIntervalMs: 100,
  })

  clock = 10
  progress.advance(100)
  clock = 20
  progress.advance(100)
  clock = 200
  progress.advance(100)

  assert.equal(lines.length, 1)
  assert.match(lines[0], /30%/)
})

test('finish always draws a final line and a newline', () => {
  const lines = []
  let clock = 0

  const progress = createProgress({
    total: 100,
    label: 'x',
    write: (line) => lines.push(line),
    now: () => clock,
    minIntervalMs: 1000,
  })

  progress.advance(100)
  progress.finish()

  assert.equal(lines.length, 1)
  assert.match(lines[0], /100%/)
  assert.match(lines[0], /\n$/)
})

test('renderProgress never shows a negative ETA when done overshoots total', () => {
  const line = renderProgress({ done: 1500, total: 1000, elapsedMs: 1000, label: 'x', width: 10 })
  assert.match(line, /100%/)
  assert.match(line, /ETA 0s/)
  assert.doesNotMatch(line, /ETA -/)
})

test('createProgress pads a redraw so a shorter line cannot leave stale characters behind', () => {
  const MB = 1024 * 1024
  const GB = 1024 * MB
  const lines = []
  let clock = 0

  const progress = createProgress({
    total: GB,
    label: 'Chunk 1/3',
    write: (line) => lines.push(line),
    now: () => clock,
    minIntervalMs: 0,
  })

  // A crawling start gives a long ETA, then a burst shrinks it: the last line is the
  // shortest one, so an unpadded redraw leaves the tail of the previous ETA on screen.
  let sent = 0
  for (const [ms, done] of [[1000, MB], [2000, 4 * MB], [3000, 512 * MB], [4000, GB]]) {
    clock = ms
    progress.advance(done - sent)
    sent = done
  }

  let widest = 0
  for (const line of lines) {
    const drawn = line.replace(/^\r/, '')
    assert.ok(drawn.length >= widest, `redraw of ${drawn.length} chars cannot cover ${widest}`)
    widest = drawn.length
  }
})

test('renderProgress measures speed by what this run moved, not by what the file has', () => {
  const line = renderProgress({
    done: 600,
    total: 1000,
    elapsedMs: 1000,
    transferred: 100,
    label: 'Chunk 2/3',
    width: 10,
  })

  assert.match(line, /60%/)
  assert.match(line, /600 B\/1000 B/)
  assert.match(line, /100 B\/s/)
  // 400 bytes left at 100 B/s. Counting the resumed 500 as speed would say ETA 1s.
  assert.match(line, /ETA 4s/)
})

test('renderProgress without transferred is unchanged', () => {
  const shape = { done: 500, total: 1000, elapsedMs: 1000, label: 'x', width: 10 }

  assert.equal(renderProgress(shape), renderProgress({ ...shape, transferred: 500 }))
})

test('createProgress starts the bar at the bytes a previous run already sent', () => {
  const lines = []
  let clock = 0

  const progress = createProgress({
    total: 1000,
    done: 400,
    label: 'Chunk 2/3',
    write: (line) => lines.push(line),
    now: () => clock,
    minIntervalMs: 0,
  })

  clock = 1000
  progress.advance(100)

  assert.equal(lines.length, 1)
  assert.match(lines[0], /50%/)
  assert.match(lines[0], /500 B\/1000 B/)
  assert.match(lines[0], /100 B\/s/)
})

test('setLabel redraws at once, whatever the throttle says', () => {
  const lines = []

  const progress = createProgress({
    total: 1000,
    label: 'Chunk 1/3',
    write: (line) => lines.push(line),
    now: () => 0,
    minIntervalMs: 1000,
  })

  progress.advance(100)
  assert.equal(lines.length, 0, 'the throttle swallows the advance')

  progress.setLabel('Chunk 2/3')

  assert.equal(lines.length, 1)
  assert.match(lines[0], /Chunk 2\/3/)
  assert.match(lines[0], /10%/)
  assert.doesNotMatch(lines[0], /\n$/, 'only finish ends the line')

  progress.advance(100)
  assert.equal(lines.length, 1, 'setLabel counts as a draw for the throttle')
})

test('one bar survives a change of label: the percentage never restarts', () => {
  const lines = []
  let clock = 0

  const progress = createProgress({
    total: 1000,
    label: 'Chunk 1/3',
    write: (line) => lines.push(line),
    now: () => (clock += 100),
    minIntervalMs: 0,
  })

  for (const [label, bytes] of [
    ['Chunk 1/3', 400],
    ['Chunk 2/3', 400],
    ['Chunk 3/3', 200],
  ]) {
    progress.setLabel(label)
    progress.advance(bytes)
  }

  progress.finish()

  const percents = lines.map((line) => Number(line.match(/(\d+)%/)[1]))

  for (let i = 1; i < percents.length; i += 1) {
    assert.ok(percents[i] >= percents[i - 1], `${percents[i]}% came after ${percents[i - 1]}%`)
  }

  assert.equal(percents.at(-1), 100)
  assert.equal(
    lines.filter((line) => line.endsWith('\n')).length,
    1,
    'the bar owns one line from start to finish',
  )
  assert.ok(
    lines.every((line) => line.includes('/1000 B')),
    'every redraw counts against the whole transfer, never against one chunk',
  )
})
