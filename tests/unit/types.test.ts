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

  it('parses minimal GameState', () => {
    const s = GameState.parse({
      timestamp: 0,
      player: { pos: null, screenPos: null, posSource: 'anchor', hp: 1, mp: 1 },
      enemies: [],
      flags: { runeActive: false, outOfBounds: false },
      popup: null,
    })
    expect(s.player.hp).toBe(1)
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
