import { describe, it, expect } from 'vitest'
import { buildGameState } from '@/perception/state-builder'
import type { PerceptionFrame } from '@/core/types'

const f: PerceptionFrame = {
  timestamp: 1000,
  detections: [
    { class: 'player', bbox: [500, 320, 40, 60], confidence: 0.98 },
    { class: 'mob_generic', bbox: [420, 300, 80, 60], confidence: 0.91 },
    { class: 'mob_generic', bbox: [650, 310, 80, 60], confidence: 0.87 },
    { class: 'rune', bbox: [1750, 100, 48, 48], confidence: 0.95 },
  ],
  screenshotMeta: { width: 1920, height: 1080 },
  overallConfidence: 0.93,
}

const minimapPos = { x: 100, y: 80 }
const bounds = { x: [25, 205] as [number, number], y: [40, 130] as [number, number] }

describe('buildGameState', () => {
  it('uses Reflex vitals (not YOLO) for hp/mp', () => {
    const s = buildGameState(f, { hp: 0.42, mp: 0.78 }, minimapPos, bounds)
    expect(s.player.hp).toBe(0.42)
    expect(s.player.mp).toBe(0.78)
  })

  it('player.pos comes from minimap (canonical)', () => {
    const s = buildGameState(f, { hp: 1, mp: 1 }, minimapPos, bounds)
    expect(s.player.pos).toEqual(minimapPos)
  })

  it('player.screenPos comes from YOLO bbox center', () => {
    const s = buildGameState(f, { hp: 1, mp: 1 }, minimapPos, bounds)
    expect(s.player.screenPos).toEqual({ x: 520, y: 350 })
  })

  it('builds enemy list with distance from screen player position', () => {
    const s = buildGameState(f, { hp: 1, mp: 1 }, minimapPos, bounds)
    expect(s.enemies.length).toBe(2)
    expect(s.enemies[0].distancePx).toBeLessThan(s.enemies[1].distancePx)
  })

  it('flags rune when rune detection >= 0.75', () => {
    const s = buildGameState(f, { hp: 1, mp: 1 }, minimapPos, bounds)
    expect(s.flags.runeActive).toBe(true)
  })

  it('flags outOfBounds when minimap pos exits bounds + margin', () => {
    const s = buildGameState(f, { hp: 1, mp: 1 }, { x: 220, y: 80 }, bounds, 10)
    expect(s.flags.outOfBounds).toBe(true)
  })

  it('player.pos null when minimapPos null', () => {
    const s = buildGameState(f, { hp: 1, mp: 1 }, null, bounds)
    expect(s.player.pos).toBeNull()
  })
})
