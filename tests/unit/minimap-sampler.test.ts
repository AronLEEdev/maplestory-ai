import { describe, it, expect, vi } from 'vitest'
import { MinimapSampler } from '@/perception/minimap'

describe('MinimapSampler', () => {
  it('returns position when capture provides matching pixels', async () => {
    const w = 80,
      h = 60
    const buf = Buffer.alloc(w * h * 4, 0)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const i = ((20 + dy) * w + (30 + dx)) * 4
        buf[i] = 240
        buf[i + 1] = 220
        buf[i + 2] = 60
        buf[i + 3] = 255
      }
    const captureRegion = vi.fn(async () => buf)
    const s = new MinimapSampler({
      captureRegion,
      region: { x: 0, y: 0, w, h },
      matcher: { rgb: [240, 220, 60], tolerance: 30 },
    })
    const pos = await s.sample()
    expect(pos).not.toBeNull()
    expect(pos!.x).toBeCloseTo(30, 0)
  })
})
