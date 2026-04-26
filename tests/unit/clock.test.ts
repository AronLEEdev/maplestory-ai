import { describe, it, expect } from 'vitest'
import { FakeClock, RealClock } from '@/core/clock'

describe('FakeClock', () => {
  it('advances time on tick()', () => {
    const c = new FakeClock(1000)
    expect(c.now()).toBe(1000)
    c.tick(500)
    expect(c.now()).toBe(1500)
  })

  it('runs scheduled intervals on tick', () => {
    const c = new FakeClock(0)
    let count = 0
    c.setInterval(() => count++, 100)
    c.tick(350)
    expect(count).toBe(3)
  })

  it('sleep() resolves when ticked', async () => {
    const c = new FakeClock(0)
    let done = false
    const p = c.sleep(50).then(() => {
      done = true
    })
    c.tick(50)
    await p
    expect(done).toBe(true)
  })
})

describe('RealClock', () => {
  it('now() returns current time', () => {
    const c = new RealClock()
    const n = c.now()
    expect(n).toBeGreaterThan(0)
  })
})
