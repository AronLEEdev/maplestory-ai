import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { captureFrames, parseDuration } from '@/dataset/capture'
import type { CaptureProvider } from '@/capture/index'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cap-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

class FakeCapture implements CaptureProvider {
  count = 0
  async captureScreen(): Promise<Buffer> {
    this.count++
    // 80×60 solid gray PNG so sharp.extract won't blow up if a crop is set.
    return await sharp(Buffer.alloc(80 * 60 * 3, 100), {
      raw: { width: 80, height: 60, channels: 3 },
    })
      .png()
      .toBuffer()
  }
  async captureRegion(): Promise<Buffer> {
    return Buffer.alloc(0)
  }
  async captureWindow(): Promise<Buffer> {
    return this.captureScreen()
  }
  canCaptureBackground(): boolean {
    return false
  }
}

describe('parseDuration', () => {
  it('parses seconds, minutes, hours', () => {
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('500ms')).toBe(500)
  })
  it('throws on garbage input', () => {
    expect(() => parseDuration('abc')).toThrow()
    expect(() => parseDuration('30')).toThrow()
  })
})

describe('captureFrames', () => {
  it('saves frames at the configured interval and exits at the deadline', async () => {
    const cap = new FakeCapture()
    const summary = await captureFrames({
      map: 't',
      capture: cap,
      intervalMs: 50,
      durationMs: 220,
      outDir: dir,
    })
    // ~5 frames at 50 ms over 220 ms (first at t=0). Allow some slack.
    expect(summary.saved).toBeGreaterThanOrEqual(3)
    expect(summary.saved).toBeLessThanOrEqual(6)
    expect(summary.outDir).toBe(dir)
    const files = readdirSync(dir).filter((f) => f.endsWith('.png'))
    expect(files.length).toBe(summary.saved)
  })

  it('crops frames to gameWindow when provided', async () => {
    const cap = new FakeCapture()
    const summary = await captureFrames({
      map: 't',
      capture: cap,
      intervalMs: 30,
      durationMs: 80,
      outDir: dir,
      gameWindow: { x: 10, y: 5, w: 40, h: 20 },
    })
    expect(summary.saved).toBeGreaterThan(0)
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .sort()
    const meta = await sharp(join(dir, files[0])).metadata()
    expect(meta.width).toBe(40)
    expect(meta.height).toBe(20)
  })

  it('shouldStop callback exits the loop early', async () => {
    const cap = new FakeCapture()
    let calls = 0
    const summary = await captureFrames({
      map: 't',
      capture: cap,
      intervalMs: 20,
      durationMs: 5000, // intentionally long
      outDir: dir,
      shouldStop: () => ++calls >= 3,
    })
    // Each iteration calls shouldStop before sleeping, so we exit by the 3rd check.
    expect(summary.saved).toBeLessThanOrEqual(3)
    expect(summary.durationMs).toBeLessThan(500)
  })
})
