import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { logger } from '@/core/logger'
import type { CaptureProvider } from '@/capture/index'
import { getForegroundWindowTitle } from '@/core/focus'

export interface CaptureFramesOpts {
  map: string
  capture: CaptureProvider
  /** ms between frames. 500 ms (2 FPS) gives ~1200 frames in 10 minutes. */
  intervalMs: number
  /** Total duration in ms. Loop exits when reached or onAbort is called. */
  durationMs: number
  /** Filter frames to only those captured while the game is foreground. */
  windowTitle?: string
  /** Optional crop rect — if set, frames are saved cropped to game-window only. */
  gameWindow?: { x: number; y: number; w: number; h: number }
  /** Override output dir. Default: data/dataset/<map>/raw/ */
  outDir?: string
  /** Polled by the loop; when it returns true, capture exits cleanly. */
  shouldStop?: () => boolean
}

export interface CaptureSummary {
  outDir: string
  saved: number
  skippedNotFocused: number
  durationMs: number
}

/**
 * Frame-grab loop for YOLO dataset collection. Runs while the game is
 * foreground; pauses (skips frames) when focus is elsewhere so the dataset
 * doesn't end up with mac desktops, terminals, or browser tabs.
 *
 * Output filenames sort lexically by capture timestamp so labelers can
 * walk the directory in order.
 */
export async function captureFrames(opts: CaptureFramesOpts): Promise<CaptureSummary> {
  const outDir = opts.outDir ?? join('data', 'dataset', opts.map, 'raw')
  mkdirSync(outDir, { recursive: true })

  const startedAt = Date.now()
  const deadline = startedAt + opts.durationMs
  let saved = 0
  let skippedNotFocused = 0
  let lastTickAt = 0

  // Sequence number disambiguates same-millisecond timestamps.
  const existing = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith('.png')).length : 0
  let seq = existing

  logger.info({ outDir, intervalMs: opts.intervalMs, durationMs: opts.durationMs }, 'capture: starting')

  while (Date.now() < deadline) {
    if (opts.shouldStop?.()) break
    const now = Date.now()
    const wait = Math.max(0, lastTickAt + opts.intervalMs - now)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastTickAt = Date.now()

    if (opts.windowTitle) {
      const title = await getForegroundWindowTitle().catch(() => null)
      if (title && !title.toLowerCase().includes(opts.windowTitle.toLowerCase())) {
        skippedNotFocused++
        continue
      }
    }

    try {
      const png = await opts.capture.captureScreen()
      const stamp = `${Date.now()}-${String(seq++).padStart(5, '0')}`
      const path = join(outDir, `${stamp}.png`)
      if (opts.gameWindow) {
        // Crop to game window so labels are scoped to game pixels only.
        const cropped = await sharp(png)
          .extract({
            left: opts.gameWindow.x,
            top: opts.gameWindow.y,
            width: opts.gameWindow.w,
            height: opts.gameWindow.h,
          })
          .png()
          .toBuffer()
        await writeFile(path, cropped)
      } else {
        await writeFile(path, png)
      }
      saved++
      if (saved % 20 === 0) {
        logger.info({ saved, skippedNotFocused }, 'capture: progress')
      }
    } catch (err) {
      logger.warn({ err }, 'capture: frame grab failed')
    }
  }

  const summary: CaptureSummary = {
    outDir,
    saved,
    skippedNotFocused,
    durationMs: Date.now() - startedAt,
  }
  logger.info(summary, 'capture: done')
  return summary
}

/**
 * Parse a duration string used by the CLI (e.g. "10m", "30s", "2h").
 * Returns milliseconds.
 */
export function parseDuration(s: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(s.trim())
  if (!m) throw new Error(`bad duration: ${s} (use e.g. 30s, 10m, 1h)`)
  const n = Number(m[1])
  switch (m[2]) {
    case 'ms':
      return n
    case 's':
      return n * 1000
    case 'm':
      return n * 60_000
    case 'h':
      return n * 3_600_000
  }
  return n
}
