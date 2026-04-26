import { describe, it, expect } from 'vitest'
import { redPixelRatio, bluePixelRatio, greenPixelRatio } from '@/reflex/pixel-sampler'

function makeRgba(pixels: [number, number, number][]): Buffer {
  const buf = Buffer.alloc(pixels.length * 4)
  pixels.forEach(([r, g, b], i) => {
    buf[i * 4 + 0] = r
    buf[i * 4 + 1] = g
    buf[i * 4 + 2] = b
    buf[i * 4 + 3] = 255
  })
  return buf
}

describe('pixel ratios', () => {
  it('redPixelRatio counts red-dominant pixels', () => {
    const buf = makeRgba([
      [255, 0, 0],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ])
    expect(redPixelRatio(buf)).toBeCloseTo(0.5, 2)
  })
  it('bluePixelRatio counts blue-dominant pixels', () => {
    const buf = makeRgba([
      [0, 0, 255],
      [0, 0, 255],
      [0, 0, 255],
      [0, 255, 0],
    ])
    expect(bluePixelRatio(buf)).toBeCloseTo(0.75, 2)
  })
  it('greenPixelRatio counts green-dominant pixels', () => {
    const buf = makeRgba([
      [0, 255, 0],
      [255, 0, 0],
    ])
    expect(greenPixelRatio(buf)).toBeCloseTo(0.5, 2)
  })
})
