import { describe, it, expect, vi } from 'vitest'
import { MinimapSampler } from '@/perception/minimap'

describe('MinimapSampler', () => {
  it('returns position when capture provides matching RGB pixels (default 3 channels)', async () => {
    const w = 80,
      h = 60
    // Runtime captureRegion returns 3-channel RGB after removeAlpha().
    const buf = Buffer.alloc(w * h * 3, 0)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const i = ((20 + dy) * w + (30 + dx)) * 3
        buf[i] = 240
        buf[i + 1] = 220
        buf[i + 2] = 60
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

  it('logs and returns null when capture throws', async () => {
    const captureRegion = vi.fn(async () => {
      throw new Error('display lost')
    })
    const s = new MinimapSampler({
      captureRegion,
      region: { x: 0, y: 0, w: 10, h: 10 },
      matcher: { rgb: [0, 0, 0], tolerance: 1 },
    })
    const pos = await s.sample()
    expect(pos).toBeNull()
  })
})
