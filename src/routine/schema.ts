import { z } from 'zod'
import { Action, Rect } from '@/core/types'

export const ReflexEntry = z.object({
  region: z.string(),
  metric: z.enum(['fill_ratio', 'red_pixel_ratio', 'blue_pixel_ratio', 'green_pixel_ratio']),
  below: z.number().min(0).max(1),
  cooldown_ms: z.number().int().min(0),
  action: Action,
})

/**
 * v2 perception: YOLO inference replaces ZNCC template matching.
 *
 * detection_mode:
 *   'yolo'   → runtime loads model_path + runs inference each tick
 *   'none'   → minimap-only mode (auto-maple style). No ML at all.
 *              Waypoint patrol + cadence-based attack via `every:` rotation.
 *   'replay' → blind playback of a recording.json. No detection, no
 *              waypoints. Bot replays the recorded keystroke timeline
 *              while reflex pots fire in parallel. Loops on completion.
 */
export const PerceptionConfig = z.object({
  detection_mode: z.enum(['yolo', 'none', 'replay']).default('yolo'),
  /** Path to the YOLO ONNX weights. Required for detection_mode='yolo'. */
  model_path: z.string().optional(),
  /** Path to recording.json. Required for detection_mode='replay'. */
  recording_path: z.string().optional(),
  fps: z.number().min(1).max(30).default(8),
  /** YOLO confidence threshold below which detections are dropped. */
  confidence_threshold: z.number().min(0).max(1).default(0.5),
})

export const RotationRule = z.union([
  z.object({
    when: z.string(),
    action: Action,
    cooldown_ms: z.number().int().min(0).optional(),
    /** Fire only after the predicate held true for this many consecutive
     *  ticks. Default 1 (current tick). Filters single-frame ZNCC flickers
     *  that would otherwise freeze patrol via pause_while_attacking. */
    min_persist_ticks: z.number().int().min(1).max(10).optional(),
  }),
  z.object({
    every: z.string(),
    action: Action,
  }),
])

export const MovementPrimitive = z.union([
  z.object({ op: z.literal('walk_to_x'), x: z.number() }),
  z.object({ op: z.literal('jump_left'), holdMs: z.number().optional() }),
  z.object({ op: z.literal('jump_right'), holdMs: z.number().optional() }),
  z.object({ op: z.literal('drop_down') }),
  z.object({ op: z.literal('wait'), ms: z.number() }),
])

export const Movement = z.object({
  primitives: z.array(MovementPrimitive),
  loop: z.boolean().default(true),
  pause_while_attacking: z.boolean().default(true),
})

export const StopCondition = z.object({
  or: z.array(
    z.union([
      z.object({ duration: z.string() }),
      z.object({
        hp_persist_below: z.object({ value: z.number(), seconds: z.number() }),
      }),
      z.object({ popup_detected: z.boolean() }),
      z.object({ out_of_bounds: z.object({ margin: z.number() }) }),
    ]),
  ),
})

export const Bounds = z.object({
  x: z.tuple([z.number(), z.number()]),
  y: z.tuple([z.number(), z.number()]),
})

export const MinimapPlayerColor = z.object({
  rgb: z.tuple([z.number(), z.number(), z.number()]),
  tolerance: z.number(),
})

export const Routine = z.object({
  game: z.literal('maplestory'),
  recorded_from: z.string().optional(),
  resolution: z.tuple([z.number(), z.number()]),
  window_title: z.string(),
  unreviewed: z.boolean().optional(),
  regions: z
    .object({
      hp: Rect,
      mp: Rect,
      minimap: Rect,
      popup: Rect.optional(),
    })
    .passthrough(),
  reflex: z.array(ReflexEntry),
  perception: PerceptionConfig,
  rotation: z.array(RotationRule),
  movement: Movement,
  stop_condition: StopCondition.optional(),
  bounds: Bounds.optional(),
  minimap_player_color: MinimapPlayerColor.optional(),
})
export type Routine = z.infer<typeof Routine>
