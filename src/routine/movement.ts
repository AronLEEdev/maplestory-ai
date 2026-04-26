import type { Action } from '@/core/types'
import type { Routine } from './schema'
import type { Clock } from '@/core/clock'

export interface MovementCtx {
  playerX: number
  attacking: boolean
}

const TOLERANCE = 5

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
        emit({ kind: 'press', key: delta > 0 ? 'right' : 'left', holdMs: 50 })
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
