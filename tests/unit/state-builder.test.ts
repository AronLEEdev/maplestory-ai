import { describe, it, expect } from 'vitest'
import { buildGameState, FAR_AWAY } from '@/perception/state-builder'
import type { PerceptionFrame } from '@/core/types'

const baseFrame: PerceptionFrame = {
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

const noPlayerFrame: PerceptionFrame = {
  ...baseFrame,
  detections: baseFrame.detections.filter((d) => d.class !== 'player'),
}

const minimapPos = { x: 100, y: 80 }
const bounds = { x: [25, 205] as [number, number], y: [40, 130] as [number, number] }

describe('buildGameState — vitals + minimap (always present)', () => {
  it('uses Reflex vitals (not perception) for hp/mp', () => {
    const s = buildGameState(baseFrame, { hp: 0.42, mp: 0.78 }, minimapPos, bounds)
    expect(s.player.hp).toBe(0.42)
    expect(s.player.mp).toBe(0.78)
  })

  it('player.pos comes from minimap (canonical)', () => {
    const s = buildGameState(baseFrame, { hp: 1, mp: 1 }, minimapPos, bounds)
    expect(s.player.pos).toEqual(minimapPos)
  })

  it('player.pos null when minimapPos null', () => {
    const s = buildGameState(baseFrame, { hp: 1, mp: 1 }, null, bounds)
    expect(s.player.pos).toBeNull()
  })

  it('flags outOfBounds when minimap pos exits bounds + margin', () => {
    const s = buildGameState(baseFrame, { hp: 1, mp: 1 }, { x: 220, y: 80 }, bounds, 10)
    expect(s.flags.outOfBounds).toBe(true)
  })

  it('flags rune when rune detection >= 0.75', () => {
    const s = buildGameState(baseFrame, { hp: 1, mp: 1 }, minimapPos, bounds)
    expect(s.flags.runeActive).toBe(true)
  })
})

describe('buildGameState — combat anchor resolution (template mode)', () => {
  it('uses player detection when present (posSource = detected)', () => {
    const s = buildGameState(baseFrame, { hp: 1, mp: 1 }, minimapPos, bounds)
    expect(s.player.posSource).toBe('detected')
    expect(s.player.screenPos).toEqual({ x: 520, y: 350 })
  })

  it('falls back to screen-center when no player detection (posSource = anchor)', () => {
    const s = buildGameState(noPlayerFrame, { hp: 1, mp: 1 }, minimapPos, bounds)
    expect(s.player.posSource).toBe('anchor')
    expect(s.player.screenPos).toEqual({ x: 960, y: 540 })
  })

  it('honours combatAnchor x/y offsets', () => {
    const s = buildGameState(noPlayerFrame, { hp: 1, mp: 1 }, minimapPos, bounds, 10, {
      x_offset_from_center: -100,
      y_offset_from_center: 50,
    })
    expect(s.player.screenPos).toEqual({ x: 860, y: 590 })
  })
})

describe('buildGameState — enemy distance', () => {
  it('horizontal metric (default) measures |dx|', () => {
    const s = buildGameState(baseFrame, { hp: 1, mp: 1 }, minimapPos, bounds)
    // player center 520; mobs at 460 (dx=60) and 690 (dx=170) → sorted asc.
    expect(s.enemies.map((e) => e.distancePx)).toEqual([60, 170])
  })

  it('y_band sentinels mobs on different platforms', () => {
    const farBelow: PerceptionFrame = {
      ...baseFrame,
      detections: [
        { class: 'player', bbox: [500, 320, 40, 60], confidence: 0.98 },
        // Mob 200 px below player center → outside y_band=80.
        { class: 'mob_generic', bbox: [510, 540, 40, 40], confidence: 0.9 },
      ],
    }
    const s = buildGameState(farBelow, { hp: 1, mp: 1 }, minimapPos, bounds, 10, {
      y_band: 80,
    })
    expect(s.enemies[0].distancePx).toBe(FAR_AWAY)
  })

  it('Bug C: distancePx survives JSON round-trip as a finite number', () => {
    const s = buildGameState(noPlayerFrame, { hp: 1, mp: 1 }, minimapPos, bounds, 10, {
      y_band: 1, // forces all mobs into FAR_AWAY
    })
    const round = JSON.parse(JSON.stringify(s)) as typeof s
    for (const e of round.enemies) {
      expect(typeof e.distancePx).toBe('number')
      expect(Number.isFinite(e.distancePx)).toBe(true)
    }
  })
})
