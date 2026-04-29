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
  template_dir: data/templates/x
  fps: 12
  match_threshold: 0.75
  stride: 2
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

  it('accepts optional combat_anchor block', () => {
    const obj = YAML.parse(valid)
    obj.perception.combat_anchor = {
      x_offset_from_center: -50,
      y_offset_from_center: 0,
      y_band: 100,
      metric: 'horizontal',
    }
    expect(() => Routine.parse(obj)).not.toThrow()
  })

  it('rejects unknown combat_anchor.metric', () => {
    const obj = YAML.parse(valid)
    obj.perception.combat_anchor = { metric: 'manhattan' }
    expect(() => Routine.parse(obj)).toThrow()
  })

  it('rejects perception block missing template_dir', () => {
    const obj = YAML.parse(valid)
    delete obj.perception.template_dir
    expect(() => Routine.parse(obj)).toThrow()
  })
})
