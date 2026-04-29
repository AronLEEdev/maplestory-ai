import type { Action } from '@/core/types'
import type { Routine } from './schema'
import type { Clock } from '@/core/clock'

export interface MovementCtx {
  playerX: number
  attacking: boolean
}

const TOLERANCE = 5
/**
 * Default hold time for a `walk_to_x` press, in milliseconds.
 *
 * Each perception tick takes ~2s (capture + ZNCC + state build). The movement
 * primitive only fires once per tick, so a 50ms tap leaves the character
 * standing for ~1950ms / tick. Bump to 800ms so the character actually walks
 * during the bulk of the tick, then briefly idles while perception runs.
 *
 * Note: while a press is being held the actuator's await blocks the run loop.
 * Reflex pots from the previous tick already fired (priority queue runs
 * emergency first). New HP/MP samples don't happen until the next tick, so
 * worst-case pot reaction lags by one full tick during continuous movement.
 * Acceptable trade-off for actually-moving gameplay.
 */
const DEFAULT_WALK_HOLD_MS = 800

export class MovementFsm {
  private idx = 0
  constructor(
    private movement: Routine['movement'],
    private _clock: Clock,
  ) {}

  tick(ctx: MovementCtx, emit: (a: Action) => void): void {
    if (ctx.attacking && this.movement.pause_while_attacking) return
    const prim = this.movement.primitives[this.idx]
    if (!prim) return
    switch (prim.op) {
      case 'walk_to_x': {
        const delta = prim.x - ctx.playerX
        if (Math.abs(delta) <= TOLERANCE) {
          this.advance()
          return
        }
        emit({
          kind: 'press',
          key: delta > 0 ? 'right' : 'left',
          holdMs: DEFAULT_WALK_HOLD_MS,
        })
        return
      }
      case 'jump_left':
        emit({ kind: 'combo', keys: ['left', 'alt'], interKeyMs: 30 })
        this.advance()
        return
      case 'jump_right':
        emit({ kind: 'combo', keys: ['right', 'alt'], interKeyMs: 30 })
        this.advance()
        return
      case 'drop_down':
        emit({ kind: 'combo', keys: ['down', 'alt'], interKeyMs: 30 })
        this.advance()
        return
      case 'wait':
        emit({ kind: 'wait', ms: prim.ms })
        this.advance()
        return
    }
  }

  private advance() {
    this.idx++
    if (this.idx >= this.movement.primitives.length && this.movement.loop) this.idx = 0
  }
}
