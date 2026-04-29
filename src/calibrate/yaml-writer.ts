import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import YAML from 'yaml'
import type { Rect } from '@/core/types'
import { Routine } from '@/routine/schema'
import { logger } from '@/core/logger'

/**
 * Calibration outputs from the browser canvas. All coordinates are in the
 * full-display-pixel space EXCEPT `bounds` and `waypointXs`, which are
 * minimap-local (i.e. coords inside the minimap region's crop).
 */
export interface CalibrationData {
  resolution: [number, number]
  windowTitle: string
  gameWindow?: Rect
  regions: { hp: Rect; mp: Rect; minimap: Rect }
  minimapPlayerColor: { rgb: [number, number, number]; tolerance: number }
  bounds: { x: [number, number]; y: [number, number] }
  waypointXs: number[]
  templateDir: string
  /** Optional combat anchor offsets — when set, pins the screen anchor used
   *  for `mobs_in_range` to the calibration-time character location. */
  combatAnchor?: {
    x_offset_from_center: number
    y_offset_from_center: number
    y_band?: number
  }
}

export interface WriteOpts {
  routinePath: string
  data: CalibrationData
  /** When true, preserve user-edited reflex/rotation/perception-tuning/stop_condition from the existing YAML. */
  preserveBehaviour?: boolean
}

const DEFAULT_REFLEX = [
  {
    region: 'hp',
    metric: 'fill_ratio',
    below: 0.5,
    cooldown_ms: 800,
    action: { kind: 'press', key: '1' },
  },
  {
    region: 'mp',
    metric: 'fill_ratio',
    below: 0.5,
    cooldown_ms: 800,
    action: { kind: 'press', key: '2' },
  },
]

const DEFAULT_ROTATION = [
  {
    // 200 native pixels horizontal — inside one character-width of attack
    // range. Anything larger and the bot locks on mobs across the screen
    // and never advances the patrol. Tune up to ~300 for long-reach attacks.
    when: 'mobs_in_range(200) >= 1',
    // attack_facing taps left/right toward nearest mob before the attack press,
    // so the bot doesn't waste cycles attacking empty air.
    action: { kind: 'attack_facing', key: 'ctrl', holdMs: 800, faceTapMs: 60 },
    cooldown_ms: 500,
  },
]

const DEFAULT_STOP_CONDITION = {
  or: [
    { duration: '1h' },
    { hp_persist_below: { value: 0.2, seconds: 30 } },
    { out_of_bounds: { margin: 10 } },
  ],
}

const DEFAULT_PERCEPTION = {
  fps: 12,
  // 0.55 filters noisier ZNCC hits from non-distinctive crops while still
  // catching most real mobs at the 1000-px haystack scale.
  match_threshold: 0.55,
  stride: 4,
  max_per_class: 8,
}

function buildMovement(waypointXs: number[]) {
  if (waypointXs.length < 2) {
    // Need at least two waypoints to form a patrol; bail with a single point.
    if (waypointXs.length === 1) {
      return {
        primitives: [{ op: 'walk_to_x', x: waypointXs[0] }],
        loop: false,
        pause_while_attacking: true,
      }
    }
    return { primitives: [], loop: true, pause_while_attacking: true }
  }
  const primitives: Array<Record<string, unknown>> = []
  for (const x of waypointXs) {
    primitives.push({ op: 'walk_to_x', x })
    primitives.push({ op: 'wait', ms: 200 })
  }
  return { primitives, loop: true, pause_while_attacking: true }
}

/**
 * Compose the full routine YAML object from calibration data.
 * If `existing` is provided AND `preserveBehaviour` is true, copy
 * reflex/rotation/perception-tuning/stop_condition from the existing object
 * so the user's edits to those fields survive a recalibration.
 */
export function composeRoutine(
  data: CalibrationData,
  existing?: Record<string, unknown>,
  preserveBehaviour = true,
): Record<string, unknown> {
  const preserved: Record<string, unknown> = {}
  if (existing && preserveBehaviour) {
    if (existing.reflex) preserved.reflex = existing.reflex
    if (existing.rotation) preserved.rotation = existing.rotation
    if (existing.stop_condition) preserved.stop_condition = existing.stop_condition
    // Preserve the user's perception tuning knobs but ALWAYS overwrite
    // template_dir (it points at a generated path the calibrator owns).
    if (existing.perception && typeof existing.perception === 'object') {
      const ep = existing.perception as Record<string, unknown>
      preserved.perception = {
        fps: ep.fps ?? DEFAULT_PERCEPTION.fps,
        match_threshold: ep.match_threshold ?? DEFAULT_PERCEPTION.match_threshold,
        stride: ep.stride ?? DEFAULT_PERCEPTION.stride,
        max_per_class: ep.max_per_class ?? DEFAULT_PERCEPTION.max_per_class,
        // Preserve a hand-tuned (or previously-derived) combat_anchor when
        // the new calibration data didn't recompute one. Without this,
        // re-saving an old calibration that used yaml-fallback hydrate would
        // wipe a working anchor and reset y to gameWindow center (the sky).
        ...(ep.combat_anchor ? { combat_anchor: ep.combat_anchor } : {}),
      }
    }
  }

  const obj: Record<string, unknown> = {
    game: 'maplestory',
    recorded_from: 'calibrate',
    resolution: data.resolution,
    window_title: data.windowTitle,
    regions: data.regions,
    minimap_player_color: data.minimapPlayerColor,
    bounds: data.bounds,
    reflex: preserved.reflex ?? DEFAULT_REFLEX,
    perception: {
      template_dir: data.templateDir, // ALWAYS overwrite — calibrator owns this path
      ...((preserved.perception as Record<string, unknown>) ?? DEFAULT_PERCEPTION),
      ...(data.combatAnchor ? { combat_anchor: data.combatAnchor } : {}),
    },
    rotation: preserved.rotation ?? DEFAULT_ROTATION,
    movement: buildMovement(data.waypointXs),
    stop_condition: preserved.stop_condition ?? DEFAULT_STOP_CONDITION,
  }
  if (data.gameWindow) obj.game_window = data.gameWindow
  return obj
}

/**
 * Write the routine YAML to disk. Validates with Routine schema before
 * writing so a bad calibration can't corrupt a working file.
 */
export function writeRoutine(opts: WriteOpts): string {
  const preserve = opts.preserveBehaviour ?? true
  const existing =
    existsSync(opts.routinePath) && preserve
      ? (YAML.parse(readFileSync(opts.routinePath, 'utf8')) as Record<string, unknown>)
      : undefined

  const composed = composeRoutine(opts.data, existing, preserve)

  // Validate before writing.
  try {
    Routine.parse(composed)
  } catch (err) {
    logger.error({ err, composed }, 'calibrate: composed routine fails schema validation')
    throw new Error(
      `composed routine failed validation: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const yamlText = YAML.stringify(composed)
  mkdirSync(dirname(opts.routinePath), { recursive: true })
  writeFileSync(opts.routinePath, yamlText)
  return opts.routinePath
}
