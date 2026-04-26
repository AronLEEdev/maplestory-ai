import { describe, it, expect, vi } from 'vitest'
import { ActionScheduler } from '@/core/scheduler'
import type { Action } from '@/core/types'
import { FakeClock } from '@/core/clock'

function recorder() {
  const got: Action[] = []
  return {
    execute: vi.fn(async (a: Action) => {
      got.push(a)
    }),
    got,
  }
}

describe('ActionScheduler', () => {
  it('executes higher-priority action first', async () => {
    const r = recorder()
    const c = new FakeClock(0)
    const s = new ActionScheduler({ execute: r.execute, clock: c })
    s.submit('routine', { kind: 'press', key: 'ctrl' }, 'routine')
    s.submit('reflex', { kind: 'press', key: 'page_up' }, 'emergency')
    await s.tick()
    expect(r.got[0]).toEqual({ kind: 'press', key: 'page_up' })
  })

  it('dedupes same press within cooldown for same source', async () => {
    const r = recorder()
    const c = new FakeClock(0)
    const s = new ActionScheduler({ execute: r.execute, clock: c, perKeyCooldownMs: 500 })
    s.submit('routine', { kind: 'press', key: 'ctrl' }, 'routine')
    s.submit('routine', { kind: 'press', key: 'ctrl' }, 'routine')
    await s.tick()
    expect(r.got.length).toBe(1)
  })

  it('clear(source) drops only that source', async () => {
    const r = recorder()
    const c = new FakeClock(0)
    const s = new ActionScheduler({ execute: r.execute, clock: c })
    s.submit('routine', { kind: 'press', key: 'ctrl' }, 'routine')
    s.submit('reflex', { kind: 'press', key: 'page_up' }, 'emergency')
    s.clear('routine')
    await s.tick()
    expect(r.got.map((a) => (a as { key: string }).key)).toEqual(['page_up'])
  })

  it('rate-limits global submissions', async () => {
    const r = recorder()
    const c = new FakeClock(0)
    const s = new ActionScheduler({ execute: r.execute, clock: c, globalRateLimitPerSec: 5 })
    for (let i = 0; i < 20; i++) {
      s.submit('routine', { kind: 'press', key: `k${i}` }, 'routine')
    }
    await s.tick()
    expect(r.got.length).toBeLessThanOrEqual(5)
  })
})
