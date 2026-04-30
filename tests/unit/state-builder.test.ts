import { describe, it, expect } from 'vitest'
import { buildGameState, PlayerTracker } from '@/perception/state-builder'
import type { YoloDetection } from '@/perception/yolo'

const minimapPos = { x: 100, y: 80 }
const bounds = { x: [25, 205] as [number, number], y: [40, 130] as [number, number] }

const playerDet: YoloDetection = {
  class: 'player',
  bbox: [500, 320, 40, 60],
  confidence: 0.98,
}
const mobLeft: YoloDetection = {
  class: 'mob',
  bbox: [400, 320, 50, 50],
  confidence: 0.92,
}
const mobRight: YoloDetection = {
  class: 'mob',
  bbox: [600, 320, 50, 50],
  confidence: 0.85,
}

describe('buildGameState — nav channel', () => {
  it('passes minimap pos through unchanged', () => {
    const s = buildGameState({
      detections: [],
      tracker: new PlayerTracker(),
      vitals: { hp: 1, mp: 1 },
      minimapPos,
    })
    expect(s.nav.playerMinimapPos).toEqual(minimapPos)
  })

  it('flags boundsOk=false when minimap pos is outside bounds + margin', () => {
    const out = { x: 500, y: 500 }
    const s = buildGameState({
      detections: [],
      tracker: new PlayerTracker(),
      vitals: { hp: 1, mp: 1 },
      minimapPos: out,
      bounds,
      boundsMargin: 10,
    })
    expect(s.nav.boundsOk).toBe(false)
  })

  it('boundsOk=true when minimap pos is null (no signal yet)', () => {
    const s = buildGameState({
      detections: [],
      tracker: new PlayerTracker(),
      vitals: { hp: 1, mp: 1 },
      minimapPos: null,
      bounds,
    })
    expect(s.nav.boundsOk).toBe(true)
  })
})

describe('buildGameState — combat channel', () => {
  it('uses player detection center when present (source=detected)', () => {
    const s = buildGameState({
      detections: [playerDet, mobLeft, mobRight],
      tracker: new PlayerTracker(),
      vitals: { hp: 1, mp: 1 },
      minimapPos,
    })
    expect(s.combat.playerScreenSource).toBe('detected')
    expect(s.combat.playerScreenPos).toEqual({ x: 520, y: 350 }) // bbox center
    expect(s.combat.confidenceOk).toBe(true)
  })

  it('source=fallback when player never detected', () => {
    const s = buildGameState({
      detections: [mobLeft, mobRight],
      tracker: new PlayerTracker(),
      vitals: { hp: 1, mp: 1 },
      minimapPos,
    })
    expect(s.combat.playerScreenSource).toBe('fallback')
    expect(s.combat.playerScreenPos).toBeNull()
    expect(s.combat.confidenceOk).toBe(false)
  })

  it('counts mobs left and right of player', () => {
    const s = buildGameState({
      detections: [playerDet, mobLeft, mobRight],
      tracker: new PlayerTracker(),
      vitals: { hp: 1, mp: 1 },
      minimapPos,
    })
    expect(s.combat.mobsLeft).toBe(1)
    expect(s.combat.mobsRight).toBe(1)
  })

  it('signs nearestMobDx (negative = mob to the left)', () => {
    const s = buildGameState({
      detections: [playerDet, mobLeft],
      tracker: new PlayerTracker(),
      vitals: { hp: 1, mp: 1 },
      minimapPos,
    })
    expect(s.combat.nearestMobDx).not.toBeNull()
    expect(s.combat.nearestMobDx).toBeLessThan(0)
  })

  it('sorts mobs by horizontal distance to player', () => {
    const close: YoloDetection = { class: 'mob', bbox: [510, 320, 30, 30], confidence: 0.9 }
    const far: YoloDetection = { class: 'mob', bbox: [800, 320, 30, 30], confidence: 0.9 }
    const s = buildGameState({
      detections: [playerDet, far, close],
      tracker: new PlayerTracker(),
      vitals: { hp: 1, mp: 1 },
      minimapPos,
    })
    expect(s.combat.mobs[0].center.x).toBeCloseTo(525, 0) // close mob first
    expect(s.combat.mobs[1].center.x).toBeCloseTo(815, 0)
  })

  it('produces empty combat geometry when no anchor available', () => {
    const s = buildGameState({
      detections: [mobLeft, mobRight], // no player
      tracker: new PlayerTracker(),
      vitals: { hp: 1, mp: 1 },
      minimapPos,
    })
    expect(s.combat.mobsLeft).toBe(0)
    expect(s.combat.mobsRight).toBe(0)
    expect(s.combat.nearestMobDx).toBeNull()
    expect(s.combat.mobs.length).toBe(2) // mobs still listed; just not anchored
  })
})

describe('PlayerTracker', () => {
  it('reports detected when YOLO returns a position', () => {
    const tr = new PlayerTracker()
    const r = tr.update({ x: 100, y: 100 })
    expect(r.source).toBe('detected')
    expect(r.pos).toEqual({ x: 100, y: 100 })
  })

  it('reports tracked for up to ttlTicks consecutive misses', () => {
    const tr = new PlayerTracker({ ttlTicks: 2 })
    tr.update({ x: 100, y: 100 })
    expect(tr.update(null).source).toBe('tracked')
    expect(tr.update(null).source).toBe('tracked')
    expect(tr.update(null).source).toBe('fallback')
  })

  it('resets stale counter on a new detection', () => {
    const tr = new PlayerTracker({ ttlTicks: 2 })
    tr.update({ x: 100, y: 100 })
    tr.update(null) // 1
    tr.update({ x: 110, y: 100 })
    expect(tr.update(null).source).toBe('tracked') // counter reset
  })
})

describe('buildGameState — vitals', () => {
  it('passes Reflex hp/mp through verbatim', () => {
    const s = buildGameState({
      detections: [],
      tracker: new PlayerTracker(),
      vitals: { hp: 0.42, mp: 0.78 },
      minimapPos,
    })
    expect(s.vitals.hp).toBe(0.42)
    expect(s.vitals.mp).toBe(0.78)
  })
})
