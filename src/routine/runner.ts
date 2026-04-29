import type { Action, GameState } from '@/core/types'
import type { Routine } from './schema'
import { compileWhen } from './dsl'
import { MovementFsm } from './movement'
import type { Clock } from '@/core/clock'

export function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(s)
  if (!m) throw new Error(`bad duration: ${s}`)
  const n = Number(m[1])
  return n * (m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : 3_600_000)
}

interface CompiledRule {
  kind: 'when' | 'every'
  predicate?: (s: GameState) => boolean
  everyMs?: number
  cooldownMs: number
  action: Action
}

export class RoutineRunner {
  private rules: CompiledRule[]
  private fsm: MovementFsm
  private lastFiredAt = new Map<number, number>()

  constructor(
    private routine: Routine,
    private clock: Clock,
    private emit: (a: Action) => void,
  ) {
    this.rules = routine.rotation.map<CompiledRule>((rule) => {
      if ('when' in rule) {
        return {
          kind: 'when',
          predicate: compileWhen(rule.when),
          cooldownMs: rule.cooldown_ms ?? 0,
          action: rule.action,
        }
      }
      return {
        kind: 'every',
        everyMs: parseDuration(rule.every),
        cooldownMs: parseDuration(rule.every),
        action: rule.action,
      }
    })
    // Stamp `every` rules so first fire is after `everyMs`, not at t=0.
    this.rules.forEach((r, i) => {
      if (r.kind === 'every') this.lastFiredAt.set(i, clock.now())
    })
    this.fsm = new MovementFsm(routine.movement, clock)
  }

  tick(state: GameState): void {
    let attacked = false
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i]
      const last = this.lastFiredAt.get(i) ?? -Infinity
      if (this.clock.now() - last < r.cooldownMs) continue
      const fire =
        r.kind === 'when' ? r.predicate!(state) : this.clock.now() - last >= r.everyMs!
      if (!fire) continue
      this.lastFiredAt.set(i, this.clock.now())
      if (r.action.kind === 'attack_facing') {
        // Expand to face-tap + attack press based on nearest enemy's screen-x.
        const action = r.action
        const player = state.player.screenPos
        const nearest = state.enemies[0] // already sorted by distance in state-builder
        if (player && nearest) {
          const dir = nearest.pos.x < player.x ? 'left' : 'right'
          this.emit({ kind: 'press', key: dir, holdMs: action.faceTapMs ?? 60 })
        }
        this.emit({ kind: 'press', key: action.key, holdMs: action.holdMs ?? 800 })
      } else {
        this.emit(r.action)
      }
      if (r.kind === 'when') attacked = true
      break
    }
    if (!attacked) {
      const px = state.player.pos?.x ?? 0
      this.fsm.tick({ playerX: px, attacking: attacked }, this.emit)
    }
  }
}
