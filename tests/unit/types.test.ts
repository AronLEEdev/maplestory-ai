import { describe, it, expect } from 'vitest'
import { Action, GameState, PerceptionFrame, Rect } from '@/core/types'

describe('zod schemas', () => {
  it('rejects malformed Rect', () => {
    expect(() => Rect.parse({ x: 1, y: 2 })).toThrow()
  })

  it('parses press Action', () => {
    const a = Action.parse({ kind: 'press', key: 'ctrl' })
    expect(a.kind).toBe('press')
  })

  it('rejects Action with bad kind', () => {
    expect(() => Action.parse({ kind: 'bogus' })).toThrow()
  })

  it('parses minimal v2 dual-channel GameState', () => {
    const s = GameState.parse({
      timestamp: 0,
      nav: { playerMinimapPos: null, boundsOk: true },
      combat: {
        playerScreenPos: null,
        playerScreenSource: 'fallback',
        mobs: [],
        nearestMobDx: null,
        mobsLeft: 0,
        mobsRight: 0,
        confidenceOk: false,
      },
      vitals: { hp: 1, mp: 1 },
      flags: { runeActive: false },
      popup: null,
    })
    expect(s.vitals.hp).toBe(1)
    expect(s.combat.confidenceOk).toBe(false)
  })

  it('parses minimal PerceptionFrame', () => {
    const f = PerceptionFrame.parse({
      timestamp: 0,
      detections: [],
      screenshotMeta: { width: 1920, height: 1080 },
      overallConfidence: 1,
    })
    expect(f.detections).toEqual([])
  })
})
