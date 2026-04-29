import { describe, it, expect } from 'vitest'
import YAML from 'yaml'
import { Routine } from '@/routine/schema'

const valid = `
game: maplestory
recorded_from: recordings/x
resolution: [1920, 1080]
window_title: "MapleStory"
regions:
  hp:      { x: 820, y: 1000, w: 140, h: 14 }
  mp:      { x: 966, y: 1000, w: 140, h: 14 }
  minimap: { x: 1820, y: 14, w: 80, h: 60 }
reflex:
  - { region: hp, metric: red_pixel_ratio, below: 0.30, cooldown_ms: 800,
      action: { kind: press, key: page_up } }
perception:
  model_path: data/models/x.onnx
  fps: 8
  confidence_threshold: 0.5
rotation:
  - { when: 'mobs_in_range(300) >= 1', action: { kind: press, key: ctrl }, cooldown_ms: 500 }
  - { every: 30s, action: { kind: press, key: shift } }
movement:
  primitives:
    - { op: walk_to_x, x: 30 }
  loop: true
stop_condition:
  or:
    - duration: 2h
    - out_of_bounds: { margin: 10 }
bounds:
  x: [25, 205]
  y: [40, 130]
minimap_player_color:
  rgb: [240, 220, 60]
  tolerance: 30
`

describe('Routine schema', () => {
  it('accepts valid YAML', () => {
    const obj = YAML.parse(valid)
    expect(() => Routine.parse(obj)).not.toThrow()
  })
  it('rejects missing regions.hp', () => {
    const obj = YAML.parse(valid)
    delete obj.regions.hp
    expect(() => Routine.parse(obj)).toThrow()
  })
  it('rejects unknown rotation rule', () => {
    const obj = YAML.parse(valid)
    obj.rotation.push({ bogus: 1 })
    expect(() => Routine.parse(obj)).toThrow()
  })

  it('accepts perception with no model_path (stub mode)', () => {
    const obj = YAML.parse(valid)
    delete obj.perception.model_path
    expect(() => Routine.parse(obj)).not.toThrow()
  })

  it('rejects negative confidence_threshold', () => {
    const obj = YAML.parse(valid)
    obj.perception.confidence_threshold = -0.1
    expect(() => Routine.parse(obj)).toThrow()
  })
})
