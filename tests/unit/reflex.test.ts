import { describe, it, expect } from 'vitest'
import {
  fillRatio,
  redPixelRatio,
  bluePixelRatio,
  greenPixelRatio,
} from '@/reflex/pixel-sampler'

/**
 * Build a tightly-packed 3-byte-per-pixel RGB buffer matching the runtime
 * captureRegion path (sharp .removeAlpha().raw().toBuffer()).
 */
function makeRgb(pixels: [number, number, number][]): Buffer {
  const buf = Buffer.alloc(pixels.length * 3)
  pixels.forEach(([r, g, b], i) => {
    buf[i * 3 + 0] = r
    buf[i * 3 + 1] = g
    buf[i * 3 + 2] = b
  })
  return buf
}

describe('fillRatio (bright AND saturated)', () => {
  it('counts only bright + colorful pixels — gray and dark are excluded', () => {
    // [255,  0,  0] bright + saturated  ✓
    // [  0,255,  0] bright + saturated  ✓
    // [255,255,255] bright but gray     ✗ (saturation = 0)
    // [100,100,100] gray middle         ✗
    // [ 10, 10, 10] dark                ✗
    const buf = makeRgb([
      [255, 0, 0],
      [0, 255, 0],
      [255, 255, 255],
      [100, 100, 100],
      [10, 10, 10],
    ])
    expect(fillRatio(buf)).toBeCloseTo(0.4, 1) // 2/5 saturated bright
  })

  it('half-filled red HP bar: trough gray excluded, bar pixels counted', () => {
    const halfRedBar = makeRgb([
      [200, 0, 0], // bar
      [200, 0, 0], // bar
      [100, 100, 100], // empty trough — gray
      [100, 100, 100], // empty trough — gray
    ])
    expect(fillRatio(halfRedBar)).toBeCloseTo(0.5, 1)
  })

  it('half-filled blue MP bar: same as half-red', () => {
    const halfBlueBar = makeRgb([
      [0, 130, 230], // bar
      [0, 130, 230], // bar
      [100, 100, 105], // empty trough — gray
      [100, 100, 105], // empty trough — gray
    ])
    expect(fillRatio(halfBlueBar)).toBeCloseTo(0.5, 1)
  })

  it('full-trough (no bar fill): reads ~0 even though trough is bright-ish', () => {
    const emptyBar = makeRgb([
      [100, 100, 100],
      [100, 100, 100],
      [100, 100, 100],
      [100, 100, 100],
    ])
    expect(fillRatio(emptyBar)).toBe(0)
  })

  it('full-bar (all colored): reads ~1', () => {
    const fullRedBar = makeRgb([
      [200, 0, 0],
      [200, 0, 0],
      [200, 0, 0],
      [200, 0, 0],
    ])
    expect(fillRatio(fullRedBar)).toBeCloseTo(1, 2)
  })
})

describe('color-specific pixel ratios (3-channel stride)', () => {
  it('redPixelRatio counts red-dominant pixels', () => {
    const buf = makeRgb([
      [255, 0, 0],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ])
    expect(redPixelRatio(buf)).toBeCloseTo(0.5, 2)
  })
  it('bluePixelRatio counts blue-dominant pixels', () => {
    const buf = makeRgb([
      [0, 0, 255],
      [0, 0, 255],
      [0, 0, 255],
      [0, 255, 0],
    ])
    expect(bluePixelRatio(buf)).toBeCloseTo(0.75, 2)
  })
  it('greenPixelRatio counts green-dominant pixels', () => {
    const buf = makeRgb([
      [0, 255, 0],
      [255, 0, 0],
    ])
    expect(greenPixelRatio(buf)).toBeCloseTo(0.5, 2)
  })
})
