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

export const EnemyState = z.object({
  type: z.string(),
  pos: Vec2,
  distancePx: z.number(),
})
export type EnemyState = z.infer<typeof EnemyState>

export const GameState = z.object({
  timestamp: z.number(),
  player: z.object({
    pos: Vec2.nullable(),         // minimap coords (canonical)
    screenPos: Vec2.nullable(),   // YOLO bbox center (screen coords) for mob distance
    hp: z.number().min(0).max(1),
    mp: z.number().min(0).max(1),
  }),
  enemies: z.array(EnemyState),
  flags: z.object({ runeActive: z.boolean(), outOfBounds: z.boolean() }),
  popup: PopupState.nullable(),
})
export type GameState = z.infer<typeof GameState>

export const Action = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('press'),  key: z.string(), holdMs: z.number().optional() }),
  z.object({ kind: z.literal('combo'),  keys: z.array(z.string()), interKeyMs: z.number().optional() }),
  z.object({ kind: z.literal('move'),   direction: z.enum(['left','right','up','down']), ms: z.number() }),
  z.object({ kind: z.literal('wait'),   ms: z.number() }),
  z.object({ kind: z.literal('abort'),  reason: z.string() }),
])
export type Action = z.infer<typeof Action>

export type ActionSource = 'reflex' | 'routine' | 'brain' | 'manual'
export type ActionPriority = 'emergency' | 'control' | 'routine' | 'background'

export const PRIORITY_ORDER: Record<ActionPriority, number> = {
  emergency: 0, control: 1, routine: 2, background: 3,
}
