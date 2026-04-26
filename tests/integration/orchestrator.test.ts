import { describe, it, expect, vi } from 'vitest'
import { Orchestrator } from '@/core/orchestrator'
import { TypedBus } from '@/core/bus'
import { FakeClock } from '@/core/clock'
import type { Routine } from '@/routine/schema'
import type { GameState } from '@/core/types'

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
    { when: 'mobs_in_range(300) >= 1', action: { kind: 'press', key: 'ctrl' }, cooldown_ms: 0 },
  ],
  movement: {
    primitives: [{ op: 'walk_to_x', x: 50 }],
    loop: true,
    pause_while_attacking: true,
  },
}

const stateStream: GameState[] = [
  {
    timestamp: 0,
    player: { pos: { x: 0, y: 0 }, screenPos: { x: 0, y: 0 }, hp: 1, mp: 1 },
    enemies: [{ type: 'mob_generic', pos: { x: 100, y: 0 }, distancePx: 100 }],
    flags: { runeActive: false, outOfBounds: false },
    popup: null,
  },
]

describe('Orchestrator (dry-run)', () => {
  it('emits actions but does not call backend', async () => {
    const bus = new TypedBus()
    const clock = new FakeClock(0)
    const sendKey = vi.fn(async () => {})
    const o = new Orchestrator({
      routine,
      bus,
      clock,
      mode: 'dry-run',
      backend: {
        sendKey,
        sendCombo: vi.fn(async () => {}),
        sendMove: vi.fn(async () => {}),
        releaseAll: vi.fn(async () => {}),
        canRunBackground: () => false,
      },
      perception: { next: async () => null },
      states: stateStream,
      getForegroundTitle: async () => 'MapleStory',
      actuatorJitterMs: 0,
    })
    await o.runOneTick()
    expect(sendKey).not.toHaveBeenCalled()
  })

  it('live mode does call backend', async () => {
    const bus = new TypedBus()
    const clock = new FakeClock(0)
    const sendKey = vi.fn(async () => {})
    const o = new Orchestrator({
      routine,
      bus,
      clock,
      mode: 'live',
      backend: {
        sendKey,
        sendCombo: vi.fn(async () => {}),
        sendMove: vi.fn(async () => {}),
        releaseAll: vi.fn(async () => {}),
        canRunBackground: () => false,
      },
      perception: { next: async () => null },
      states: stateStream,
      getForegroundTitle: async () => 'MapleStory',
      actuatorJitterMs: 0,
    })
    await o.runOneTick()
    expect(sendKey).toHaveBeenCalled()
  })
})
