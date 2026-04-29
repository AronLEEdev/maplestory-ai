import { describe, it, expect } from 'vitest'
import { findPlayerDot } from '@/perception/minimap'

function makeBuf(
  w: number,
  h: number,
  channels: 3 | 4,
  dot: { x: number; y: number; rgb: [number, number, number] } | null,
): Buffer {
  const buf = Buffer.alloc(w * h * channels, 0)
  if (dot) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = dot.x + dx,
          y = dot.y + dy
        if (x < 0 || y < 0 || x >= w || y >= h) continue
        const i = (y * w + x) * channels
        buf[i + 0] = dot.rgb[0]
        buf[i + 1] = dot.rgb[1]
        buf[i + 2] = dot.rgb[2]
        if (channels === 4) buf[i + 3] = 255
      }
    }
  }
  return buf
}

describe('findPlayerDot — RGB (3 channels, runtime default)', () => {
  it('finds yellow dot location in RGB buffer', () => {
    const buf = makeBuf(80, 60, 3, { x: 30, y: 20, rgb: [240, 220, 60] })
    const pos = findPlayerDot(buf, 80, 60, { rgb: [240, 220, 60], tolerance: 30 })
    expect(pos).not.toBeNull()
    expect(pos!.x).toBeCloseTo(30, 0)
    expect(pos!.y).toBeCloseTo(20, 0)
  })

  it('returns null when no matching dot', () => {
    const buf = makeBuf(80, 60, 3, null)
    const pos = findPlayerDot(buf, 80, 60, { rgb: [240, 220, 60], tolerance: 10 })
    expect(pos).toBeNull()
  })

  it('ignores pixels outside tolerance', () => {
    const buf = makeBuf(80, 60, 3, { x: 10, y: 10, rgb: [10, 10, 10] })
    const pos = findPlayerDot(buf, 80, 60, { rgb: [240, 220, 60], tolerance: 30 })
    expect(pos).toBeNull()
  })

  it('regression: defaults to 3-channel stride (Bug B v1.2)', () => {
    // Stride mismatch (3-channel buffer read with 4-channel index) caused the
    // dot to be missed at runtime in v1.1. Default channels=3 fixes it.
    const buf = makeBuf(80, 60, 3, { x: 40, y: 30, rgb: [240, 220, 60] })
    const pos = findPlayerDot(buf, 80, 60, { rgb: [240, 220, 60], tolerance: 30 })
    expect(pos).not.toBeNull()
    expect(pos!.x).toBeCloseTo(40, 0)
  })
})

describe('findPlayerDot — RGBA (4 channels, opt-in)', () => {
  it('finds dot when caller passes channels=4', () => {
    const buf = makeBuf(80, 60, 4, { x: 30, y: 20, rgb: [240, 220, 60] })
    const pos = findPlayerDot(buf, 80, 60, { rgb: [240, 220, 60], tolerance: 30 }, 4)
    expect(pos).not.toBeNull()
    expect(pos!.x).toBeCloseTo(30, 0)
  })
})
