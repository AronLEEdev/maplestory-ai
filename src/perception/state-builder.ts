import type { PerceptionFrame, GameState, EnemyState, Vec2 } from '@/core/types'

const RUNE_THRESHOLD = 0.75

export interface Bounds {
  x: [number, number]
  y: [number, number]
}

function bboxCenter(b: [number, number, number, number]): Vec2 {
  return { x: b[0] + b[2] / 2, y: b[1] + b[3] / 2 }
}

function dist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x,
    dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
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

export function buildGameState(
  frame: PerceptionFrame,
  vitals: { hp: number; mp: number },
  minimapPos: Vec2 | null,
  bounds: Bounds | null = null,
  boundsMargin: number = 10,
): GameState {
  const players = frame.detections
    .filter((d) => d.class === 'player')
    .sort((a, b) => b.confidence - a.confidence)
  const screenPos = players.length ? bboxCenter(players[0].bbox) : null

  const enemies: EnemyState[] = frame.detections
    .filter((d) => d.class.startsWith('mob'))
    .map((d) => {
      const pos = bboxCenter(d.bbox)
      return {
        type: d.class,
        pos,
        distancePx: screenPos ? dist(pos, screenPos) : Infinity,
      }
    })
    .sort((a, b) => a.distancePx - b.distancePx)

  const runeActive = frame.detections.some(
    (d) => d.class === 'rune' && d.confidence >= RUNE_THRESHOLD,
  )

  return {
    timestamp: frame.timestamp,
    player: { pos: minimapPos, screenPos, hp: vitals.hp, mp: vitals.mp },
    enemies,
    flags: { runeActive, outOfBounds: outOfBounds(minimapPos, bounds, boundsMargin) },
    popup: null,
  }
}
