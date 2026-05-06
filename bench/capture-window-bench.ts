/**
 * Same bench but targets a single Window instead of full Monitor.
 * Game window is ~1918×1128, way smaller than full retina (3024×1964 = 5.4MB
 * raw). If node-screenshots' Window capture is faster than Monitor, we may
 * still hit 30 FPS without a Swift sidecar.
 */
import { Window, Monitor } from 'node-screenshots'

const DURATION_MS = Number(process.argv[2] ?? 5000)
const MODE = (process.argv[3] ?? 'raw') as 'png' | 'raw'
const TITLE_FILTER = process.argv[4] ?? 'maplestory'

async function main() {
  const wins = Window.all().filter((w) =>
    (w.title() ?? '').toLowerCase().includes(TITLE_FILTER.toLowerCase()) ||
    (w.appName() ?? '').toLowerCase().includes(TITLE_FILTER.toLowerCase()),
  )
  if (wins.length === 0) {
    console.log(`no window matched "${TITLE_FILTER}". listing all:`)
    for (const w of Window.all().slice(0, 10)) {
      console.log(`  pid=${w.pid()} app=${w.appName()} title=${w.title()}`)
    }
    return
  }
  const w = wins[0]
  console.log(
    `window: pid=${w.pid()} app=${w.appName()} title=${w.title()} ${w.width()}x${w.height()}`,
  )
  console.log(`mode: ${MODE}, duration: ${DURATION_MS}ms`)

  // Warm.
  await w.captureImage()

  const mss: number[] = []
  const startedAt = Date.now()
  let firstBytes = 0
  let dims: [number, number] = [0, 0]
  while (Date.now() - startedAt < DURATION_MS) {
    const t0 = Date.now()
    const img = await w.captureImage()
    const buf = MODE === 'png' ? await img.toPng() : await img.toRaw()
    mss.push(Date.now() - t0)
    if (!firstBytes) {
      firstBytes = buf.length
      dims = [img.width, img.height]
    }
  }

  const elapsed = Date.now() - startedAt
  mss.sort((a, b) => a - b)
  const fps = (mss.length * 1000) / elapsed
  const avg = mss.reduce((a, b) => a + b, 0) / mss.length
  const p50 = mss[Math.floor(mss.length / 2)]
  const p95 = mss[Math.floor(mss.length * 0.95)]
  console.log()
  console.log(`samples: ${mss.length}  elapsed: ${elapsed}ms`)
  console.log(`fps: ${fps.toFixed(2)}  avg: ${avg.toFixed(1)}ms  p50: ${p50}ms  p95: ${p95}ms`)
  console.log(`bytes/frame: ~${firstBytes}  dims: ${dims[0]}x${dims[1]}`)
  // For comparison
  const m = Monitor.all().find((x) => x.isPrimary())
  if (m) {
    console.log(`(monitor for reference: ${m.width()}x${m.height()} scale=${m.scaleFactor()})`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
