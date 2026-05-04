import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { composeRoutine, writeRoutine, type CalibrationData } from '@/calibrate/yaml-writer'

let dir: string

const baseData: CalibrationData = {
  resolution: [3024, 1964],
  windowTitle: 'MapleStory Worlds',
  regions: {
    hp: { x: 1615, y: 1172, w: 247, h: 30 },
    mp: { x: 1866, y: 1172, w: 247, h: 30 },
    minimap: { x: 1105, y: 138, w: 302, h: 370 },
  },
  minimapPlayerColor: { rgb: [255, 255, 136], tolerance: 12 },
  bounds: { x: [10, 280], y: [200, 350] },
  waypointXs: [30, 250],
  modelPath: 'data/models/henesys.onnx',
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cal-yw-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('composeRoutine', () => {
  it('builds a valid routine from calibration data', () => {
    const r = composeRoutine(baseData)
    expect(r.game).toBe('maplestory')
    expect(r.resolution).toEqual([3024, 1964])
    expect(r.window_title).toBe('MapleStory Worlds')
    expect(r.regions).toEqual(baseData.regions)
    expect(r.minimap_player_color).toEqual({ rgb: [255, 255, 136], tolerance: 12 })
    expect(r.bounds).toEqual({ x: [10, 280], y: [200, 350] })
  })

  it('movement: produces walk_to_x + wait for each waypoint, loops', () => {
    const r = composeRoutine(baseData)
    const m = r.movement as { primitives: Array<Record<string, unknown>>; loop: boolean }
    expect(m.loop).toBe(true)
    expect(m.primitives).toEqual([
      { op: 'walk_to_x', x: 30 },
      { op: 'wait', ms: 200 },
      { op: 'walk_to_x', x: 250 },
      { op: 'wait', ms: 200 },
    ])
  })

  it('movement: handles single waypoint by emitting non-looping primitive', () => {
    const r = composeRoutine({ ...baseData, waypointXs: [50] })
    const m = r.movement as { primitives: Array<Record<string, unknown>>; loop: boolean }
    expect(m.loop).toBe(false)
    expect(m.primitives).toEqual([{ op: 'walk_to_x', x: 50 }])
  })

  it('preserves user-edited reflex/rotation/stop_condition when preserveBehaviour=true', () => {
    const existing = {
      reflex: [
        {
          region: 'hp',
          metric: 'fill_ratio',
          below: 0.3, // user edited from 0.5 → 0.3
          cooldown_ms: 800,
          action: { kind: 'press', key: '1' },
        },
      ],
      rotation: [
        {
          when: 'mobs_in_range(500) >= 2', // user tightened
          action: { kind: 'press', key: 'd', holdMs: 600 },
          cooldown_ms: 400,
        },
      ],
      perception: {
        confidence_threshold: 0.55, // user tuned
        fps: 6,
      },
      stop_condition: {
        or: [{ duration: '30m' }],
      },
    }
    const r = composeRoutine(baseData, existing, true)
    expect(r.reflex).toEqual(existing.reflex)
    expect(r.rotation).toEqual(existing.rotation)
    expect(r.stop_condition).toEqual(existing.stop_condition)
    expect(
      (r.perception as Record<string, unknown>).confidence_threshold,
    ).toBe(0.55)
    expect((r.perception as Record<string, unknown>).fps).toBe(6)
  })

  it('always overwrites perception.model_path even when preserving behaviour', () => {
    const existing = {
      perception: {
        model_path: 'data/models/old.onnx',
        confidence_threshold: 0.55,
      },
    }
    const r = composeRoutine(
      { ...baseData, modelPath: 'data/models/henesys.onnx' },
      existing,
      true,
    )
    expect(
      (r.perception as Record<string, unknown>).model_path,
    ).toBe('data/models/henesys.onnx')
  })

  it('overwrites everything when preserveBehaviour=false', () => {
    const existing = {
      reflex: [{ region: 'hp', metric: 'fill_ratio', below: 0.1, cooldown_ms: 1, action: { kind: 'press', key: 'q' } }],
    }
    const r = composeRoutine(baseData, existing, false)
    // Default reflex has 2 entries; user's edit is dropped.
    expect((r.reflex as unknown[]).length).toBe(2)
  })
})

describe('writeRoutine', () => {
  it('writes a valid YAML file that survives round-trip parse', () => {
    const path = join(dir, 'routine.yaml')
    writeRoutine({ routinePath: path, data: baseData })
    const text = readFileSync(path, 'utf8')
    const parsed = YAML.parse(text)
    expect(parsed.game).toBe('maplestory')
    expect(parsed.bounds).toEqual({ x: [10, 280], y: [200, 350] })
  })

  it('preserves existing user edits across rewrite', () => {
    const path = join(dir, 'routine.yaml')
    writeRoutine({ routinePath: path, data: baseData })
    // simulate user editing the threshold
    const obj = YAML.parse(readFileSync(path, 'utf8'))
    obj.reflex[0].below = 0.25
    writeFileSync(path, YAML.stringify(obj))
    // recalibrate (e.g. user moved game window)
    writeRoutine({
      routinePath: path,
      data: { ...baseData, regions: { ...baseData.regions, hp: { x: 999, y: 999, w: 100, h: 30 } } },
    })
    const after = YAML.parse(readFileSync(path, 'utf8'))
    expect(after.reflex[0].below).toBe(0.25) // user's edit preserved
    expect(after.regions.hp.x).toBe(999)     // calibrator re-wrote the region
  })

  it('throws when composed routine fails schema validation', () => {
    const bad = { ...baseData, resolution: [0, 0] as [number, number] }
    // Force regions to be invalid by removing the minimap.
    bad.regions = { ...bad.regions }
    delete (bad.regions as { minimap?: unknown }).minimap
    expect(() => writeRoutine({ routinePath: join(dir, 'r.yaml'), data: bad })).toThrow()
  })
})

describe('composeRoutine — detection_mode branching (v2.2)', () => {
  it('default mode is yolo: writes attack_facing rotation + pause_while_attacking=true', () => {
    const r = composeRoutine(baseData)
    const perception = r.perception as Record<string, unknown>
    expect(perception.detection_mode).toBe('yolo')
    const rot = r.rotation as Array<{ when?: string; action: { kind: string } }>
    expect(rot[0].when).toContain('mobs_in_range')
    expect(rot[0].action.kind).toBe('attack_facing')
    const mv = r.movement as { pause_while_attacking: boolean }
    expect(mv.pause_while_attacking).toBe(true)
  })

  it('mode=none: writes cadence press rotation + pause_while_attacking=false', () => {
    const r = composeRoutine({ ...baseData, detectionMode: 'none' })
    const perception = r.perception as Record<string, unknown>
    expect(perception.detection_mode).toBe('none')
    const rot = r.rotation as Array<{ every?: string; action: { kind: string; key: string } }>
    expect(rot[0].every).toBe('500ms')
    expect(rot[0].action.kind).toBe('press')
    const mv = r.movement as { pause_while_attacking: boolean }
    expect(mv.pause_while_attacking).toBe(false)
  })

  it('mode=none yaml validates against the Routine schema', () => {
    const path = join(dir, 'r.yaml')
    writeRoutine({ routinePath: path, data: { ...baseData, detectionMode: 'none' } })
    const obj = YAML.parse(readFileSync(path, 'utf8'))
    expect(obj.perception.detection_mode).toBe('none')
  })
})
