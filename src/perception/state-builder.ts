import type {
  PerceptionFrame,
  GameState,
  EnemyState,
  Vec2,
  PosSource,
} from '@/core/types'
import { logger } from '@/core/logger'

const RUNE_THRESHOLD = 0.75
const PLAYER_DETECTION_THRESHOLD = 0.7
/**
 * Sentinel for "mob distance unknown" or "mob filtered by y_band".
 * Use a finite value so JSON round-trips don't turn it into `null`, which
 * silently breaks DSL comparisons (Bug C in v1.1).
 */
export const FAR_AWAY = Number.MAX_SAFE_INTEGER

export interface Bounds {
  x: [number, number]
  y: [number, number]
}

export interface CombatAnchorConfig {
  /** Pixels to add to screenW/2 for the X axis. Negative shifts left. */
  x_offset_from_center?: number
  /** Pixels to add to screenH/2 for the Y axis. Negative shifts up. */
  y_offset_from_center?: number
  /** Mobs more than this many y-pixels from the anchor are considered out of fight range (different platform). 0 / undefined = disabled. */
  y_band?: number
  /** Distance metric for `mobs_in_range(...)`. Default 'horizontal' — matches 2D side-scrolling combat. */
  metric?: 'horizontal' | 'euclidean'
}

function bboxCenter(b: [number, number, number, number]): Vec2 {
  return { x: b[0] + b[2] / 2, y: b[1] + b[3] / 2 }
}

function dist(a: Vec2, b: Vec2, metric: 'horizontal' | 'euclidean'): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return metric === 'horizontal' ? Math.abs(dx) : Math.sqrt(dx * dx + dy * dy)
}

function outOfBounds(p: Vec2 | null, b: Bounds | null, margin: number): boolean {
  if (!p || !b) return false
  return (
    p.x < b.x[0] - margin ||
    p.x > b.x[1] + margin ||
    p.y < b.y[0] - margin ||
    p.y > b.y[1] + margin
  )
}

/**
 * Build a GameState from a PerceptionFrame + side-channel inputs.
 *
 * Combat distance resolution (template mode):
 *   1. If a `player` detection meets PLAYER_DETECTION_THRESHOLD, anchor on
 *      its bbox center. posSource = 'detected'.
 *   2. Else fall back to the configured anchor (default screen center +
 *      offsets). posSource = 'anchor'.
 *
 * Movement/bounds always uses minimapPos. The minimap is the canonical
 * spatial coordinate system; screenPos is for combat range only.
 */
export function buildGameState(
  frame: PerceptionFrame,
  vitals: { hp: number; mp: number },
  minimapPos: Vec2 | null,
  bounds: Bounds | null = null,
  boundsMargin: number = 10,
  combatAnchorCfg: CombatAnchorConfig = {},
): GameState {
  const screenW = frame.screenshotMeta.width
  const screenH = frame.screenshotMeta.height

  // Two-tier combat anchor.
  const playerDet = frame.detections
    .filter((d) => d.class === 'player' && d.confidence >= PLAYER_DETECTION_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence)[0]
  let screenPos: Vec2 | null = null
  let posSource: PosSource = 'anchor'
  if (playerDet) {
    screenPos = bboxCenter(playerDet.bbox)
    posSource = 'detected'
  } else {
    screenPos = {
      x: screenW / 2 + (combatAnchorCfg.x_offset_from_center ?? 0),
      y: screenH / 2 + (combatAnchorCfg.y_offset_from_center ?? 0),
    }
    posSource = 'anchor'
  }
  const yBand = combatAnchorCfg.y_band ?? 0
  const metric = combatAnchorCfg.metric ?? 'horizontal'

  let outOfYBandCount = 0
  const enemies: EnemyState[] = frame.detections
    .filter((d) => d.class.startsWith('mob'))
    .map<EnemyState>((d) => {
      const pos = bboxCenter(d.bbox)
      const dy = pos.y - screenPos!.y
      const inBand = yBand <= 0 || Math.abs(dy) <= yBand
      if (!inBand) outOfYBandCount++
      return {
        type: d.class,
        pos,
        distancePx: inBand ? dist(pos, screenPos!, metric) : FAR_AWAY,
      }
    })
    .sort((a, b) => a.distancePx - b.distancePx)

  if (yBand > 0 && outOfYBandCount > 0) {
    logger.debug({ outOfYBandCount, yBand }, 'state-builder: mobs filtered by y_band')
  }

  const runeActive = frame.detections.some(
    (d) => d.class === 'rune' && d.confidence >= RUNE_THRESHOLD,
  )

  return {
    timestamp: frame.timestamp,
    player: {
      pos: minimapPos,
      screenPos,
      posSource,
      hp: vitals.hp,
      mp: vitals.mp,
    },
    enemies,
    flags: { runeActive, outOfBounds: outOfBounds(minimapPos, bounds, boundsMargin) },
    popup: null,
  }
}
