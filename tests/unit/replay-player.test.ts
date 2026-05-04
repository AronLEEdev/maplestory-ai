import { describe, it, expect } from 'vitest'
import { FakeClock } from '@/core/clock'
import { ReplayPlayer } from '@/replay/player'
import type { Action } from '@/core/types'
import type { Recording } from '@/replay/format'

function rec(events: Recording['events'], durationMs: number): Recording {
  return {
    version: 1,
    map: 't',
    recordedAt: '2026-01-01T00:00:00Z',
    durationMs,
    windowTitle: 'X',
    events,
  }
}

describe('ReplayPlayer', () => {
  it('pairs keydown/keyup into a press with the recorded hold duration', () => {
    const c = new FakeClock(0)
    const got: Action[] = []
    const p = new ReplayPlayer({
      recording: rec(
        [
          { t: 100, type: 'keydown', key: 'right' },
          { t: 600, type: 'keyup', key: 'right' },
        ],
        2000,
      ),
      clock: c,
      emit: (a) => got.push(a),
      loop: false,
    })
    p.start()
    c.tick(99)
    p.tick()
    expect(got.length).toBe(0) // not yet
    c.tick(1) // 100ms elapsed — keydown consumed but no keyup yet
    p.tick()
    expect(got.length).toBe(0)
    c.tick(500) // 600ms elapsed — keyup arrives
    p.tick()
    expect(got).toEqual([{ kind: 'press', key: 'right', holdMs: 500 }])
  })

  it('fires multiple events that fall in the same tick window', () => {
    const c = new FakeClock(0)
    const got: Action[] = []
    const p = new ReplayPlayer({
      recording: rec(
        [
          { t: 10, type: 'keydown', key: 'a' },
          { t: 50, type: 'keyup', key: 'a' },
          { t: 100, type: 'keydown', key: 'b' },
          { t: 200, type: 'keyup', key: 'b' },
        ],
        500,
      ),
      clock: c,
      emit: (a) => got.push(a),
      loop: false,
    })
    p.start()
    c.tick(300)
    p.tick()
    expect(got.length).toBe(2)
    expect(got[0]).toEqual({ kind: 'press', key: 'a', holdMs: 40 })
    expect(got[1]).toEqual({ kind: 'press', key: 'b', holdMs: 100 })
  })

  it('loops back to start after durationMs', () => {
    const c = new FakeClock(0)
    const got: Action[] = []
    const p = new ReplayPlayer({
      recording: rec(
        [
          { t: 0, type: 'keydown', key: 'x' },
          { t: 100, type: 'keyup', key: 'x' },
        ],
        500,
      ),
      clock: c,
      emit: (a) => got.push(a),
      loop: true,
    })
    p.start()
    c.tick(150)
    p.tick()
    expect(got.length).toBe(1)
    c.tick(400) // 550ms total — past durationMs, loop wraps
    p.tick()
    c.tick(150) // 150ms into second loop, x press fires again
    p.tick()
    expect(got.length).toBe(2)
    expect(got[1]).toEqual({ kind: 'press', key: 'x', holdMs: 100 })
  })

  it('isDone() reports false while looping, true after non-looping playthrough', () => {
    const c = new FakeClock(0)
    const p = new ReplayPlayer({
      recording: rec(
        [
          { t: 0, type: 'keydown', key: 'x' },
          { t: 50, type: 'keyup', key: 'x' },
        ],
        100,
      ),
      clock: c,
      emit: () => {},
      loop: false,
    })
    p.start()
    c.tick(60)
    p.tick()
    expect(p.isDone()).toBe(false)
    c.tick(50)
    p.tick()
    expect(p.isDone()).toBe(true)
  })

  it('drops orphan keyup events without throwing', () => {
    const c = new FakeClock(0)
    const got: Action[] = []
    const p = new ReplayPlayer({
      recording: rec(
        [
          { t: 0, type: 'keyup', key: 'rogue' }, // no matching keydown
          { t: 10, type: 'keydown', key: 'a' },
          { t: 20, type: 'keyup', key: 'a' },
        ],
        100,
      ),
      clock: c,
      emit: (a) => got.push(a),
      loop: false,
    })
    p.start()
    c.tick(50)
    p.tick()
    expect(got).toEqual([{ kind: 'press', key: 'a', holdMs: 10 }])
  })
})
