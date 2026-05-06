/**
 * Capture benchmark: measure node-screenshots throughput and per-frame
 * latency on the primary display, both raw and game-window-cropped.
 *
 * Decides v2.5 phase 0 → 1A vs 1B. Pass criteria:
 *   ≥30 FPS sustained, ≤30ms per frame.
 */
import { Monitor } from 'node-screenshots'

interface Sample {
  ms: number
  bytes: number
  width: number
  height: number
}

const DURATION_MS = Number(process.argv[2] ?? 5000)
const MODE = (process.argv[3] ?? 'png') as 'png' | 'raw'

async function main() {
  const m = Monitor.all().find((x) => x.isPrimary()) ?? Monitor.all()[0]
  if (!m) throw new Error('no monitor')
  console.log(
    `monitor: id=${m.id()} ${m.width()}x${m.height()} scale=${m.scaleFactor()} primary=${m.isPrimary()}`,
  )
  console.log(`mode: ${MODE}, duration: ${DURATION_MS}ms`)

  // Warm-up — first capture is always slow.
  await m.captureImage()

  const samples: Sample[] = []
  const startedAt = Date.now()
  while (Date.now() - startedAt < DURATION_MS) {
    const t0 = Date.now()
    const img = await m.captureImage()
    const buf =
      MODE === 'png' ? await img.toPng() : await img.toRaw()
    samples.push({
      ms: Date.now() - t0,
      bytes: buf.length,
      width: img.width,
      height: img.height,
    })
  }

  const elapsed = Date.now() - startedAt
  const fps = (samples.length * 1000) / elapsed
  const mss = samples.map((s) => s.ms).sort((a, b) => a - b)
  const p50 = mss[Math.floor(mss.length / 2)]
  const p95 = mss[Math.floor(mss.length * 0.95)]
  const p99 = mss[Math.floor(mss.length * 0.99)]
  const avg = mss.reduce((a, b) => a + b, 0) / mss.length
  console.log()
  console.log(`samples:    ${samples.length}`)
  console.log(`elapsed:    ${elapsed}ms`)
  console.log(`fps:        ${fps.toFixed(2)}`)
  console.log(`per-frame:  avg=${avg.toFixed(1)}ms  p50=${p50}ms  p95=${p95}ms  p99=${p99}ms`)
  console.log(`bytes/frame:~${samples[0].bytes}`)
  console.log(`dims:       ${samples[0].width}x${samples[0].height}`)

  console.log()
  if (fps >= 30 && p95 <= 30) {
    console.log('✅ PASS — node-screenshots is fast enough. Proceed with phase 1A (pure Node).')
  } else {
    console.log('❌ FAIL — too slow. Plan calls for phase 1B (Swift sidecar).')
    console.log(`     need fps>=30 and p95<=30ms; got fps=${fps.toFixed(1)} p95=${p95}ms`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
