import { describe, it, expect } from 'vitest'
import { MovementFsm } from '@/routine/movement'
import { FakeClock } from '@/core/clock'
import type { Action } from '@/core/types'
import type { Routine } from '@/routine/schema'

const movement: Routine['movement'] = {
  primitives: [
    { op: 'walk_to_x', x: 30 },
    { op: 'walk_to_x', x: 170 },
  ],
  loop: true,
  pause_while_attacking: true,
}

function actionsFromFsm(fsm: MovementFsm, playerX: number): Action[] {
  const got: Action[] = []
  fsm.tick({ playerX, attacking: false }, (a) => got.push(a))
  return got
}

describe('MovementFsm', () => {
  it('walks right to reach x=30 from x=0', () => {
    const fsm = new MovementFsm(movement, new FakeClock(0))
    const a = actionsFromFsm(fsm, 0)
    expect(a[0]).toEqual({ kind: 'press', key: 'right', holdMs: 800 })
  })
  it('walks left to reach x=30 from x=200', () => {
    const fsm = new MovementFsm(movement, new FakeClock(0))
    const a = actionsFromFsm(fsm, 200)
    expect(a[0]).toEqual({ kind: 'press', key: 'left', holdMs: 800 })
  })
  it('advances to next primitive when within tolerance', () => {
    const fsm = new MovementFsm(movement, new FakeClock(0))
    actionsFromFsm(fsm, 30)
    const a2 = actionsFromFsm(fsm, 30)
    expect(a2[0]).toEqual({ kind: 'press', key: 'right', holdMs: 800 })
  })
  it('emits no action when attacking and pause_while_attacking', () => {
    const fsm = new MovementFsm(movement, new FakeClock(0))
    const got: Action[] = []
    fsm.tick({ playerX: 0, attacking: true }, (a) => got.push(a))
    expect(got).toEqual([])
  })
})
