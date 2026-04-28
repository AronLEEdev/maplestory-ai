import { z } from 'zod'
import { Action, Rect } from '@/core/types'

export const ReflexEntry = z.object({
  region: z.string(),
  metric: z.enum(['red_pixel_ratio', 'blue_pixel_ratio', 'green_pixel_ratio']),
  below: z.number().min(0).max(1),
  cooldown_ms: z.number().int().min(0),
  action: Action,
})

export const PerceptionYolo = z.object({
  mode: z.literal('yolo'),
  model: z.string(),
  fps: z.number().min(1).max(30),
  classes: z.array(z.string()).min(1),
  confidence_threshold: z.number().min(0).max(1),
})

export const PerceptionTemplate = z.object({
  mode: z.literal('template'),
  template_dir: z.string(),
  fps: z.number().min(1).max(30),
  match_threshold: z.number().min(0).max(1).default(0.75),
  stride: z.number().int().min(1).max(8).default(2),
  search_region: Rect.optional(),
})

export const PerceptionConfig = z.discriminatedUnion('mode', [PerceptionYolo, PerceptionTemplate])

export const RotationRule = z.union([
  z.object({
    when: z.string(),
    action: Action,
    cooldown_ms: z.number().int().min(0).optional(),
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

/**
 * Backward compat: v1 routines stored perception as a flat object without a
 * `mode` discriminator. Treat any such legacy block as `mode: 'yolo'`.
 *
 * Mutates `obj` in place and returns it. Callers should use this before
 * Routine.parse() when reading user-authored YAML/JSON.
 */
export function coerceLegacyPerception<T extends Record<string, unknown>>(obj: T): T {
  const p = (obj as { perception?: Record<string, unknown> }).perception
  if (p && typeof p === 'object' && !p.mode) {
    p.mode = 'yolo'
  }
  return obj
}

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
