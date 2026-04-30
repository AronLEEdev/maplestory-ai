import type { GameState, MobState, PlayerScreenSource, Vec2 } from '@/core/types'
import type { YoloDetection } from './yolo'

export interface Bounds {
  x: [number, number]
  y: [number, number]
}

export interface PlayerTrackerOpts {
  /** Number of consecutive missed-detection ticks the tracker keeps reusing
   *  the last known player position before falling back. Default 3. */
  ttlTicks?: number
}

/**
 * Short-term player-position tracker. When YOLO detects the player, the
 * tracker latches the position. When YOLO misses for up to `ttlTicks`,
 * it keeps reporting the last known position with source='tracked' so
 * combat decisions degrade gracefully through brief animation occlusion.
 * After TTL expires it returns null with source='fallback'.
 */
export class PlayerTracker {
  private last: Vec2 | null = null
  private staleTicks = 0
  private readonly ttl: number

  constructor(opts: PlayerTrackerOpts = {}) {
    this.ttl = opts.ttlTicks ?? 3
  }

  update(detected: Vec2 | null): { pos: Vec2 | null; source: PlayerScreenSource } {
    if (detected) {
      this.last = detected
      this.staleTicks = 0
      return { pos: detected, source: 'detected' }
    }
    if (this.last && this.staleTicks < this.ttl) {
      this.staleTicks++
      return { pos: this.last, source: 'tracked' }
    }
    return { pos: null, source: 'fallback' }
  }

  reset(): void {
    this.last = null
    this.staleTicks = 0
  }
}

export interface BuildStateOpts {
  /** YOLO detections in display-space coords, all classes. */
  detections: YoloDetection[]
  /** Player tracker — updated in-place. Pass the same instance every tick. */
  tracker: PlayerTracker
  vitals: { hp: number; mp: number }
  /** Minimap-local player position from the minimap sampler, or null on miss. */
  minimapPos: Vec2 | null
  /** Patrol bounds (minimap-local), if configured. */
  bounds?: Bounds | null
  /** Margin (minimap-local px) added to bounds before flagging out-of-bounds. */
  boundsMargin?: number
  timestamp?: number
}

/**
 * Fuse YOLO detections + minimap into the v2 dual-channel BotState.
 *
 *   nav    ← minimap pos + bounds check
 *   combat ← player + mob detections, anchored on the tracked player pos
 *
 * Mobs are sorted by horizontal distance to the player's screen position.
 * left/right counts use the same anchor. When the tracker reports
 * source='fallback' (no usable player anchor), all combat geometry
 * collapses to "no mobs in range" — combat predicates won't fire.
 */
export function buildGameState(opts: BuildStateOpts): GameState {
  const ts = opts.timestamp ?? Date.now()

  // 1. Player anchor.
  const playerDet = opts.detections
    .filter((d) => d.class === 'player')
    .sort((a, b) => b.confidence - a.confidence)[0]
  const detectedCenter = playerDet
    ? bboxCenter(playerDet.bbox)
    : null
  const tracked = opts.tracker.update(detectedCenter)

  // 2. Mobs with center + distance.
  const mobs: MobState[] = opts.detections
    .filter((d) => d.class === 'mob')
    .map((d) => ({
      bbox: rectFromBbox(d.bbox),
      center: bboxCenter(d.bbox),
      confidence: d.confidence,
    }))

  // 3. Sort + count by side relative to anchor.
  let nearestMobDx: number | null = null
  let mobsLeft = 0
  let mobsRight = 0
  if (tracked.pos) {
    const ax = tracked.pos.x
    mobs.sort(
      (a, b) =>
        Math.abs(a.center.x - ax) - Math.abs(b.center.x - ax),
    )
    if (mobs.length > 0) {
      nearestMobDx = mobs[0].center.x - ax
    }
    for (const m of mobs) {
      if (m.center.x < ax) mobsLeft++
      else mobsRight++
    }
  }

  // 4. Nav channel.
  const boundsOk =
    !opts.minimapPos || !opts.bounds
      ? true
      : !outOfBounds(opts.minimapPos, opts.bounds, opts.boundsMargin ?? 10)

  // 5. Compose state.
  return {
    timestamp: ts,
    nav: {
      playerMinimapPos: opts.minimapPos,
      boundsOk,
    },
    combat: {
      playerScreenPos: tracked.pos,
      playerScreenSource: tracked.source,
      mobs,
      nearestMobDx,
      mobsLeft,
      mobsRight,
      confidenceOk: tracked.source !== 'fallback',
    },
    vitals: opts.vitals,
    flags: { runeActive: false },
    popup: null,
  }
}

function bboxCenter(b: [number, number, number, number]): Vec2 {
  return { x: b[0] + b[2] / 2, y: b[1] + b[3] / 2 }
}

function rectFromBbox(b: [number, number, number, number]) {
  return { x: b[0], y: b[1], w: b[2], h: b[3] }
}

function outOfBounds(p: Vec2, b: Bounds, margin: number): boolean {
  return (
    p.x < b.x[0] - margin ||
    p.x > b.x[1] + margin ||
    p.y < b.y[0] - margin ||
    p.y > b.y[1] + margin
  )
}
