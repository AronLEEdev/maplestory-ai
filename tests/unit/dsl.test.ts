import { describe, it, expect } from 'vitest'
import { compileWhen } from '@/routine/dsl'
import type { GameState } from '@/core/types'

const state: GameState = {
  timestamp: 0,
  nav: { playerMinimapPos: { x: 100, y: 100 }, boundsOk: true },
  combat: {
    playerScreenPos: { x: 100, y: 100 },
    playerScreenSource: 'detected',
    mobs: [
      {
        bbox: { x: 225, y: 75, w: 50, h: 50 },
        center: { x: 250, y: 100 },
        confidence: 0.9,
      },
      {
        bbox: { x: 575, y: 75, w: 50, h: 50 },
        center: { x: 600, y: 100 },
        confidence: 0.85,
      },
    ],
    nearestMobDx: 150,
    mobsLeft: 0,
    mobsRight: 2,
    confidenceOk: true,
  },
  vitals: { hp: 0.5, mp: 0.4 },
  flags: { runeActive: false },
  popup: null,
}

describe('compileWhen', () => {
  it('mobs_in_range counts within radius', () => {
    expect(compileWhen('mobs_in_range(200) >= 1')(state)).toBe(true)
    expect(compileWhen('mobs_in_range(200) >= 2')(state)).toBe(false)
  })
  it('hp comparator', () => {
    expect(compileWhen('hp < 0.6')(state)).toBe(true)
    expect(compileWhen('mp < 0.3')(state)).toBe(false)
  })
  it('rune_active boolean', () => {
    expect(compileWhen('rune_active')(state)).toBe(false)
  })
  it('rejects arbitrary JS', () => {
    expect(() => compileWhen('process.exit(0)')).toThrow()
    expect(() => compileWhen('require("fs")')).toThrow()
  })

  it('rejects malformed grammar at compile time, not run time', () => {
    expect(() => compileWhen('hp hp hp')).toThrow()
    expect(() => compileWhen('hp <')).toThrow()
    expect(() => compileWhen('mobs_in_range(')).toThrow()
    expect(() => compileWhen('(hp < 0.3')).toThrow()
  })

  it('supports && and ||', () => {
    expect(compileWhen('hp < 0.6 && mp < 0.5')(state)).toBe(true)
    expect(compileWhen('hp < 0.6 && mp > 0.5')(state)).toBe(false)
    expect(compileWhen('hp > 0.9 || mp < 0.5')(state)).toBe(true)
  })

  it('supports parens', () => {
    expect(compileWhen('(hp < 0.6) && (mp < 0.5)')(state)).toBe(true)
    expect(compileWhen('(hp > 0.9 || mp < 0.5) && rune_active')(state)).toBe(false)
  })
})
