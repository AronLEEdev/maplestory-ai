import { describe, it, expect } from 'vitest'
import { ReflexWorker } from '@/reflex/pixel-sampler'
import { FakeClock } from '@/core/clock'

function lowHpRegion(): Buffer {
  return Buffer.alloc(100 * 3, 0)
}
function fullHpRegion(): Buffer {
  const b = Buffer.alloc(100 * 3)
  for (let i = 0; i < 100; i++) {
    b[i * 3] = 255
    b[i * 3 + 1] = 0
    b[i * 3 + 2] = 0
  }
  return b
}

describe('ReflexWorker', () => {
  it('fires action when below threshold + cooldown allows', async () => {
    const submits: string[] = []
    const c = new FakeClock(0)
    const w = new ReflexWorker({
      clock: c,
      submit: (a) => submits.push((a as { key: string }).key),
      checks: [
        {
          region: 'hp',
          metric: 'red_pixel_ratio',
          below: 0.3,
          cooldownMs: 800,
          action: { kind: 'press', key: 'page_up' },
        },
      ],
      sample: async (region) => (region === 'hp' ? lowHpRegion() : Buffer.alloc(0)),
    })
    await w.tick()
    expect(submits).toEqual(['page_up'])
  })

  it('does not fire when above threshold', async () => {
    const submits: string[] = []
    const c = new FakeClock(0)
    const w = new ReflexWorker({
      clock: c,
      submit: (a) => submits.push((a as { key: string }).key),
      checks: [
        {
          region: 'hp',
          metric: 'red_pixel_ratio',
          below: 0.3,
          cooldownMs: 800,
          action: { kind: 'press', key: 'page_up' },
        },
      ],
      sample: async () => fullHpRegion(),
    })
    await w.tick()
    expect(submits).toEqual([])
  })

  it('respects cooldown', async () => {
    const submits: string[] = []
    const c = new FakeClock(0)
    const w = new ReflexWorker({
      clock: c,
      submit: (a) => submits.push((a as { key: string }).key),
      checks: [
        {
          region: 'hp',
          metric: 'red_pixel_ratio',
          below: 0.3,
          cooldownMs: 800,
          action: { kind: 'press', key: 'page_up' },
        },
      ],
      sample: async () => lowHpRegion(),
    })
    await w.tick()
    await w.tick()
    expect(submits.length).toBe(1)
    c.tick(900)
    await w.tick()
    expect(submits.length).toBe(2)
  })
})
