const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '--'
  if (n < 1024) return `${n} B`

  let value = n
  let unit = 0

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value.toFixed(1)} ${UNITS[unit]}`
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '--'

  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60

  if (h > 0) return `${h}h${m}m`
  if (m > 0) return `${m}m${s}s`
  return `${s}s`
}

export function renderProgress({ done, total, elapsedMs, label, width = 24, transferred = done }) {
  const ratio = total === 0 ? 1 : Math.min(done / total, 1)
  const filled = Math.round(ratio * width)
  const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`

  // Speed measures what this run moved, not what the file already has. A resumed upload
  // starts with gigabytes behind it, and dividing those by a two-second-old run reports a
  // fictional 3 GB/s and an ETA of almost nothing. The bar and the byte counts still speak
  // for the whole file, because that is the question being asked.
  const bytesPerSecond = elapsedMs > 0 ? transferred / (elapsedMs / 1000) : 0
  // Clamp to 0: done can overshoot total (one extra tick) and a negative ETA is meaningless.
  const remaining = bytesPerSecond > 0 ? Math.max(0, (total - done) / bytesPerSecond) : Infinity

  const percent = String(Math.floor(ratio * 100)).padStart(3)
  const speed = `${formatBytes(Math.round(bytesPerSecond))}/s`

  return `${label} ${bar} ${percent}% ${formatBytes(done)}/${formatBytes(total)} ${speed} ETA ${formatDuration(remaining)}`
}

// A percentage of an unknown total is an invented number, and an ETA from one is worse: it
// would count down to a finish nobody can predict.
export function renderStreamProgress({ done, elapsedMs, label }) {
  const bytesPerSecond = elapsedMs > 0 ? done / (elapsedMs / 1000) : 0

  return `${label} ${formatBytes(done)} sent ${formatBytes(Math.round(bytesPerSecond))}/s`
}

export function createStreamProgress({
  label,
  write = (line) => process.stderr.write(line),
  now = () => Date.now(),
  minIntervalMs = 200,
}) {
  const startedAt = now()
  let done = 0
  let currentLabel = label
  let lastDrawnAt = startedAt
  let widestLine = 0

  // Same \r discipline as createProgress: a redraw shorter than the one before it would
  // leave the previous line's tail on screen, so pad every line out to the widest drawn so far.
  function draw(suffix) {
    const line = renderStreamProgress({ done, elapsedMs: now() - startedAt, label: currentLabel })
    widestLine = Math.max(widestLine, line.length)
    write(`\r${line.padEnd(widestLine)}${suffix}`)
  }

  return {
    advance(bytes) {
      done += bytes
      if (now() - lastDrawnAt < minIntervalMs) return
      lastDrawnAt = now()
      draw('')
    },
    setLabel(next) {
      currentLabel = next
      lastDrawnAt = now()
      draw('')
    },
    finish() {
      draw('\n')
    },
  }
}

// A number turned into words a person reads: "1 chunk" for one, "3 chunks" for the rest.
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function createProgress({
  total,
  label,
  // Bytes a previous run already sent. They belong on the bar — the question is how much of
  // the file is done, not how much of today's session — but not in the speed.
  done: startedWith = 0,
  write = (line) => process.stderr.write(line),
  now = () => Date.now(),
  minIntervalMs = 200,
}) {
  const startedAt = now()
  let done = startedWith
  let currentLabel = label
  let lastDrawnAt = startedAt
  let widestLine = 0

  // \r only moves the cursor home, it does not erase. A redraw that is shorter than the one
  // before it (a shrinking ETA, a speed that changes unit) would leave the previous tail on
  // screen, so pad every line out to the widest one drawn so far.
  function draw(suffix) {
    const line = renderProgress({
      done,
      total,
      elapsedMs: now() - startedAt,
      label: currentLabel,
      transferred: done - startedWith,
    })
    widestLine = Math.max(widestLine, line.length)
    write(`\r${line.padEnd(widestLine)}${suffix}`)
  }

  return {
    advance(bytes) {
      done += bytes
      if (now() - lastDrawnAt < minIntervalMs) return
      lastDrawnAt = now()
      draw('')
    },
    // One bar spans the whole transfer while the label names the chunk in flight, so the
    // label changes mid-line and has to be drawn at once: throttled, it would keep showing
    // the previous chunk's number for the first 200ms of the new one. It counts as a draw,
    // because the redraw a moment later would say the same thing.
    setLabel(next) {
      currentLabel = next
      lastDrawnAt = now()
      draw('')
    },
    finish() {
      draw('\n')
    },
  }
}
