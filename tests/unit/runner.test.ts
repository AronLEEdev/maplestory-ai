import { describe, it, expect } from 'vitest'
import { RoutineRunner, parseDuration } from '@/routine/runner'
import { FakeClock } from '@/core/clock'
import type { GameState, Action } from '@/core/types'
import type { Routine } from '@/routine/schema'

const routine: Routine = {
  game: 'maplestory',
  resolution: [1920, 1080],
  window_title: 'MapleStory',
  regions: {
    hp: { x: 0, y: 0, w: 1, h: 1 },
    mp: { x: 0, y: 0, w: 1, h: 1 },
    minimap: { x: 0, y: 0, w: 1, h: 1 },
  },
  reflex: [],
  perception: { model: 'm', fps: 8, classes: ['player'], confidence_threshold: 0.5 },
  rotation: [
    { when: 'mobs_in_range(300) >= 1', action: { kind: 'press', key: 'ctrl' }, cooldown_ms: 500 },
    { every: '30s', action: { kind: 'press', key: 'shift' } },
  ],
  movement: {
    primitives: [{ op: 'walk_to_x', x: 50 }],
    loop: true,
    pause_while_attacking: true,
  },
}

function stateWithMobs(distance: number, playerX = 0): GameState {
  return {
    timestamp: 0,
    player: { pos: { x: playerX, y: 0 }, screenPos: { x: playerX, y: 0 }, posSource: 'detected', hp: 1, mp: 1 },
    enemies:
      distance >= 0
        ? [{ type: 'mob_generic', pos: { x: playerX + distance, y: 0 }, distancePx: distance }]
        : [],
    flags: { runeActive: false, outOfBounds: false },
    popup: null,
  }
}

describe('parseDuration', () => {
  it('parses seconds, minutes, hours', () => {
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('2h')).toBe(7_200_000)
  })
})

describe('RoutineRunner', () => {
  it('fires rotation rule when condition true', () => {
    const c = new FakeClock(0)
    const got: Action[] = []
    const r = new RoutineRunner(routine, c, (a) => got.push(a))
    r.tick(stateWithMobs(100))
    expect(got.some((a) => (a as { key: string }).key === 'ctrl')).toBe(true)
  })

  it('respects rotation cooldown', () => {
    const c = new FakeClock(0)
    const got: Action[] = []
    const r = new RoutineRunner(routine, c, (a) => got.push(a))
    r.tick(stateWithMobs(100))
    r.tick(stateWithMobs(100))
    expect(got.filter((a) => (a as { key: string }).key === 'ctrl').length).toBe(1)
    c.tick(600)
    r.tick(stateWithMobs(100))
    expect(got.filter((a) => (a as { key: string }).key === 'ctrl').length).toBe(2)
  })

  it('fires `every` rule on cadence', () => {
    const c = new FakeClock(0)
    const got: Action[] = []
    const r = new RoutineRunner(routine, c, (a) => got.push(a))
    r.tick(stateWithMobs(-1))
    expect(got.some((a) => (a as { key: string }).key === 'shift')).toBe(false)
    c.tick(31_000)
    r.tick(stateWithMobs(-1))
    expect(got.some((a) => (a as { key: string }).key === 'shift')).toBe(true)
  })

  it('attack_facing expands to face-tap then attack press', () => {
    const c = new FakeClock(0)
    const got: Action[] = []
    const facingRoutine: Routine = {
      ...routine,
      rotation: [
        {
          when: 'mobs_in_range(300) >= 1',
          action: { kind: 'attack_facing', key: 'ctrl', holdMs: 800, faceTapMs: 60 },
          cooldown_ms: 500,
        },
      ],
    }
    const r = new RoutineRunner(facingRoutine, c, (a) => got.push(a))
    // Mob to the LEFT of player (player at x=500, mob at x=200) → face left.
    const left: GameState = {
      timestamp: 0,
      player: { pos: { x: 0, y: 0 }, screenPos: { x: 500, y: 0 }, posSource: 'detected', hp: 1, mp: 1 },
      enemies: [{ type: 'mob_x', pos: { x: 200, y: 0 }, distancePx: 100 }],
      flags: { runeActive: false, outOfBounds: false },
      popup: null,
    }
    r.tick(left)
    expect(got).toEqual([
      { kind: 'press', key: 'left', holdMs: 60 },
      { kind: 'press', key: 'ctrl', holdMs: 800 },
    ])
  })

  it('min_persist_ticks gates a one-tick flicker — fires on the second consecutive true tick', () => {
    const c = new FakeClock(0)
    const got: Action[] = []
    const persistRoutine: Routine = {
      ...routine,
      rotation: [
        {
          when: 'mobs_in_range(300) >= 1',
          action: { kind: 'press', key: 'ctrl' },
          cooldown_ms: 0,
          min_persist_ticks: 2,
        },
      ],
    }
    const r = new RoutineRunner(persistRoutine, c, (a) => got.push(a))
    // Tick 1: mob present → counter goes to 1, BELOW min_persist_ticks=2 → no fire.
    r.tick(stateWithMobs(100))
    expect(got.filter((a) => (a as { key: string }).key === 'ctrl').length).toBe(0)
    // Tick 2: still present → counter 2, fires.
    r.tick(stateWithMobs(100))
    expect(got.filter((a) => (a as { key: string }).key === 'ctrl').length).toBe(1)
  })

  it('min_persist_ticks resets on a missed predicate', () => {
    const c = new FakeClock(0)
    const got: Action[] = []
    const persistRoutine: Routine = {
      ...routine,
      rotation: [
        {
          when: 'mobs_in_range(300) >= 1',
          action: { kind: 'press', key: 'ctrl' },
          cooldown_ms: 0,
          min_persist_ticks: 2,
        },
      ],
    }
    const r = new RoutineRunner(persistRoutine, c, (a) => got.push(a))
    r.tick(stateWithMobs(100)) // counter 1
    r.tick(stateWithMobs(-1))  // counter resets to 0 (no mob)
    r.tick(stateWithMobs(100)) // counter 1, still below 2 → no fire
    expect(got.filter((a) => (a as { key: string }).key === 'ctrl').length).toBe(0)
  })

  it('emits movement when no mob in range', () => {
    const c = new FakeClock(0)
    const got: Action[] = []
    const r = new RoutineRunner(routine, c, (a) => got.push(a))
    r.tick(stateWithMobs(-1, 0))
    expect(got.some((a) => a.kind === 'press' && a.key === 'right')).toBe(true)
  })
})
