import { describe, it, expect } from 'vitest'
import { compileWhen } from '@/routine/dsl'
import type { GameState } from '@/core/types'

const state: GameState = {
  timestamp: 0,
  player: { pos: { x: 100, y: 100 }, screenPos: { x: 100, y: 100 }, posSource: 'detected', hp: 0.5, mp: 0.4 },
  enemies: [
    { type: 'mob_generic', pos: { x: 250, y: 100 }, distancePx: 150 },
    { type: 'mob_generic', pos: { x: 600, y: 100 }, distancePx: 500 },
  ],
  flags: { runeActive: false, outOfBounds: false },
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
