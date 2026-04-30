import { z } from 'zod'

export const Rect = z.object({
  x: z.number(), y: z.number(), w: z.number(), h: z.number(),
})
export type Rect = z.infer<typeof Rect>

export const Vec2 = z.object({ x: z.number(), y: z.number() })
export type Vec2 = z.infer<typeof Vec2>

export const Detection = z.object({
  class: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  confidence: z.number().min(0).max(1),
})
export type Detection = z.infer<typeof Detection>

export const OcrBlock = z.object({
  text: z.string(),
  bbox: Rect,
  confidence: z.number(),
})
export type OcrBlock = z.infer<typeof OcrBlock>

export const PerceptionFrame = z.object({
  timestamp: z.number(),
  detections: z.array(Detection),
  ocr: z.array(OcrBlock).optional(),
  screenshotMeta: z.object({ width: z.number(), height: z.number() }),
  overallConfidence: z.number().min(0).max(1),
})
export type PerceptionFrame = z.infer<typeof PerceptionFrame>

export const PopupState = z.object({
  text: z.string(),
  kind: z.enum(['event', 'dc', 'gm', 'unknown']),
})
export type PopupState = z.infer<typeof PopupState>

/**
 * v2 detected-mob entry. The `class` is implicit ("mob"); we don't carry
 * species since the detector is two-class only.
 */
export const MobState = z.object({
  /** Bbox in display-space pixels. */
  bbox: Rect,
  /** Bbox center, display-space. */
  center: Vec2,
  /** YOLO confidence [0, 1]. */
  confidence: z.number().min(0).max(1),
})
export type MobState = z.infer<typeof MobState>

/** How the player's on-screen position was determined this tick. */
export const PlayerScreenSource = z.enum(['detected', 'tracked', 'fallback'])
export type PlayerScreenSource = z.infer<typeof PlayerScreenSource>

/**
 * v2 dual-channel runtime state.
 *
 * - `nav`: minimap-derived. Authoritative for movement and bounds.
 * - `combat`: YOLO-derived. Authoritative for attack decisions.
 * - `vitals` and `flags` are independent samples.
 *
 * The two channels never need to agree on a single "player position";
 * the calling code picks the right channel per question.
 */
export const GameState = z.object({
  timestamp: z.number(),
  nav: z.object({
    /** Player position in minimap-local coords. null when not detected this tick. */
    playerMinimapPos: Vec2.nullable(),
    /** False when minimap pos is outside the configured bounds + margin. */
    boundsOk: z.boolean(),
  }),
  combat: z.object({
    /** Player center in display-space pixels. null when no detection and tracker exhausted. */
    playerScreenPos: Vec2.nullable(),
    playerScreenSource: PlayerScreenSource,
    /** Mobs detected this tick, sorted by horizontal distance to playerScreenPos. */
    mobs: z.array(MobState),
    /** Signed dx of the nearest mob center from playerScreenPos. <0=left, >0=right. */
    nearestMobDx: z.number().nullable(),
    /** Counts split by side relative to playerScreenPos. */
    mobsLeft: z.number().int().min(0),
    mobsRight: z.number().int().min(0),
    /** True when playerScreenPos came from `detected` or `tracked` (not `fallback`). */
    confidenceOk: z.boolean(),
  }),
  vitals: z.object({
    hp: z.number().min(0).max(1),
    mp: z.number().min(0).max(1),
  }),
  flags: z.object({ runeActive: z.boolean() }),
  popup: PopupState.nullable(),
})
export type GameState = z.infer<typeof GameState>

export const Action = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('press'),  key: z.string(), holdMs: z.number().optional() }),
  z.object({ kind: z.literal('combo'),  keys: z.array(z.string()), interKeyMs: z.number().optional() }),
  z.object({ kind: z.literal('move'),   direction: z.enum(['left','right','up','down']), ms: z.number() }),
  z.object({ kind: z.literal('wait'),   ms: z.number() }),
  z.object({ kind: z.literal('abort'),  reason: z.string() }),
  // attack_facing is a routine-level action expanded by RoutineRunner into a
  // sequence of presses (face direction → attack key) using state.enemies.
  // Never reaches the Actuator directly.
  z.object({
    kind: z.literal('attack_facing'),
    key: z.string(),
    holdMs: z.number().optional(),
    faceTapMs: z.number().optional(),
  }),
])
export type Action = z.infer<typeof Action>

export type ActionSource = 'reflex' | 'routine' | 'brain' | 'manual'
export type ActionPriority = 'emergency' | 'control' | 'routine' | 'background'

export const PRIORITY_ORDER: Record<ActionPriority, number> = {
  emergency: 0, control: 1, routine: 2, background: 3,
}
