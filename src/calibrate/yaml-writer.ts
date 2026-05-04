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
  /** Path to the YOLO ONNX weights for this map (data/models/<map>.onnx).
   *  Used when detectionMode === 'yolo'; ignored when 'none'/'replay'. */
  modelPath: string
  /** Path to the replay recording.json (replays/<map>/recording.json).
   *  Used when detectionMode === 'replay'. */
  recordingPath?: string
  /** v2.2: 'yolo' = train + use YOLO. 'none' = minimap + cadence attack
   *  only (auto-maple style). 'replay' = record-and-play (no detection,
   *  blind playback of recording.json). Default 'yolo' for backward compat. */
  detectionMode?: 'yolo' | 'none' | 'replay'
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

const DEFAULT_ROTATION_YOLO = [
  {
    // 200 native pixels horizontal — inside one character-width of attack
    // range. Anything larger and the bot locks on mobs across the screen
    // and never advances the patrol. Tune up to ~300 for long-reach attacks.
    when: 'mobs_in_range(200) >= 1',
    // attack_facing taps left/right toward nearest mob before the attack press,
    // so the bot doesn't waste cycles attacking empty air.
    action: { kind: 'attack_facing', key: 'ctrl', holdMs: 800, faceTapMs: 60 },
    cooldown_ms: 500,
    // Require 2 consecutive ticks of mobs-in-range before pausing patrol.
    // Filters single-frame flickers that would otherwise freeze movement.
    min_persist_ticks: 2,
  },
]

// detection_mode='none' (auto-maple style): no mob detection. Just press
// the attack key on a fixed cadence while patrolling. The character walks
// through mobs and the periodic attack catches them in range.
const DEFAULT_ROTATION_NONE = [
  {
    every: '500ms',
    action: { kind: 'press', key: 'ctrl', holdMs: 200 },
  },
]

// detection_mode='replay': blind playback. Rotation + movement empty —
// the recording IS the routine. Reflex still fires in parallel for pots.
const DEFAULT_ROTATION_REPLAY: Array<Record<string, unknown>> = []

const DEFAULT_STOP_CONDITION = {
  or: [
    { duration: '1h' },
    { hp_persist_below: { value: 0.2, seconds: 30 } },
    { out_of_bounds: { margin: 10 } },
  ],
}

const DEFAULT_PERCEPTION = {
  fps: 8,
  confidence_threshold: 0.5,
}

function buildMovement(waypointXs: number[], detectionMode: 'yolo' | 'none' | 'replay') {
  // YOLO mode: pause walking while attacking — bot stops to face + hit the
  // mob, then resumes patrol.
  // NONE mode: never pause — character keeps walking and attack-on-cadence
  // catches mobs in passing. pause_while_attacking would deadlock the patrol
  // because every rotation rule fires every tick.
  // REPLAY mode: movement is empty — the recording drives all keypresses.
  if (detectionMode === 'replay') {
    return { primitives: [], loop: false, pause_while_attacking: false }
  }
  const pause = detectionMode === 'yolo'
  if (waypointXs.length < 2) {
    if (waypointXs.length === 1) {
      return {
        primitives: [{ op: 'walk_to_x', x: waypointXs[0] }],
        loop: false,
        pause_while_attacking: pause,
      }
    }
    return { primitives: [], loop: true, pause_while_attacking: pause }
  }
  const primitives: Array<Record<string, unknown>> = []
  for (const x of waypointXs) {
    primitives.push({ op: 'walk_to_x', x })
    primitives.push({ op: 'wait', ms: 200 })
  }
  return { primitives, loop: true, pause_while_attacking: pause }
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
        confidence_threshold:
          ep.confidence_threshold ?? DEFAULT_PERCEPTION.confidence_threshold,
      }
    }
  }

  const detectionMode: 'yolo' | 'none' | 'replay' = data.detectionMode ?? 'yolo'
  const defaultRotation =
    detectionMode === 'replay'
      ? DEFAULT_ROTATION_REPLAY
      : detectionMode === 'none'
        ? DEFAULT_ROTATION_NONE
        : DEFAULT_ROTATION_YOLO

  const perceptionBase: Record<string, unknown> = {
    detection_mode: detectionMode,
    ...((preserved.perception as Record<string, unknown>) ?? DEFAULT_PERCEPTION),
  }
  if (detectionMode === 'yolo') perceptionBase.model_path = data.modelPath
  if (detectionMode === 'replay' && data.recordingPath)
    perceptionBase.recording_path = data.recordingPath

  const obj: Record<string, unknown> = {
    game: 'maplestory',
    recorded_from: 'calibrate',
    resolution: data.resolution,
    window_title: data.windowTitle,
    regions: data.regions,
    minimap_player_color: data.minimapPlayerColor,
    bounds: data.bounds,
    reflex: preserved.reflex ?? DEFAULT_REFLEX,
    perception: perceptionBase,
    rotation: preserved.rotation ?? defaultRotation,
    movement: buildMovement(data.waypointXs, detectionMode),
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
