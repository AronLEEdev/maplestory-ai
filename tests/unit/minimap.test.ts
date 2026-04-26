import { describe, it, expect } from 'vitest'
import { findPlayerDot } from '@/perception/minimap'

function makeRgba(
  w: number,
  h: number,
  dot: { x: number; y: number; rgb: [number, number, number] } | null,
): Buffer {
  const buf = Buffer.alloc(w * h * 4, 0)
  if (dot) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = dot.x + dx,
          y = dot.y + dy
        if (x < 0 || y < 0 || x >= w || y >= h) continue
        const i = (y * w + x) * 4
        buf[i + 0] = dot.rgb[0]
        buf[i + 1] = dot.rgb[1]
        buf[i + 2] = dot.rgb[2]
        buf[i + 3] = 255
      }
    }
  }
  return buf
}

describe('findPlayerDot', () => {
  it('finds yellow dot location', () => {
    const buf = makeRgba(80, 60, { x: 30, y: 20, rgb: [240, 220, 60] })
    const pos = findPlayerDot(buf, 80, 60, { rgb: [240, 220, 60], tolerance: 30 })
    expect(pos).not.toBeNull()
    expect(pos!.x).toBeCloseTo(30, 0)
    expect(pos!.y).toBeCloseTo(20, 0)
  })

  it('returns null when no matching dot', () => {
    const buf = makeRgba(80, 60, null)
    const pos = findPlayerDot(buf, 80, 60, { rgb: [240, 220, 60], tolerance: 10 })
    expect(pos).toBeNull()
  })

  it('ignores pixels outside tolerance', () => {
    const buf = makeRgba(80, 60, { x: 10, y: 10, rgb: [10, 10, 10] })
    const pos = findPlayerDot(buf, 80, 60, { rgb: [240, 220, 60], tolerance: 30 })
    expect(pos).toBeNull()
  })
})
