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
  /** Consecutive ticks the predicate must hold true before the rule fires.
   *  Filters single-frame ZNCC flickers that would otherwise freeze patrol. */
  minPersistTicks: number
  action: Action
}

export class RoutineRunner {
  private rules: CompiledRule[]
  private fsm: MovementFsm
  private lastFiredAt = new Map<number, number>()
  /** Consecutive-true-tick counter per rule (for `min_persist_ticks`). */
  private persistTicks = new Map<number, number>()

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
          minPersistTicks: rule.min_persist_ticks ?? 1,
          action: rule.action,
        }
      }
      return {
        kind: 'every',
        everyMs: parseDuration(rule.every),
        cooldownMs: parseDuration(rule.every),
        minPersistTicks: 1,
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
      // Update the per-rule persist counter from this tick's predicate.
      // `every` rules don't need persistence — they fire on a clock cadence.
      if (r.kind === 'when') {
        const truthy = r.predicate!(state)
        const prev = this.persistTicks.get(i) ?? 0
        this.persistTicks.set(i, truthy ? prev + 1 : 0)
      }
      if (this.clock.now() - last < r.cooldownMs) continue
      let fire: boolean
      if (r.kind === 'when') {
        fire = (this.persistTicks.get(i) ?? 0) >= r.minPersistTicks
      } else {
        fire = this.clock.now() - last >= r.everyMs!
      }
      if (!fire) continue
      this.lastFiredAt.set(i, this.clock.now())
      if (r.action.kind === 'attack_facing') {
        const action = r.action
        // Direction priority:
        //  1. detected player template + nearest mob.x compare (most accurate)
        //  2. movement FSM's intended direction toward the next waypoint
        //     (robust when the player template is missing — the common case)
        //  3. last-walked direction
        const player = state.player.screenPos
        const nearest = state.enemies[0]
        let dir: 'left' | 'right' | null = null
        if (state.player.posSource === 'detected' && player && nearest) {
          dir = nearest.pos.x < player.x ? 'left' : 'right'
        } else {
          const playerX = state.player.pos?.x ?? 0
          dir = this.fsm.intendedDir(playerX) ?? this.fsm.lastDir()
        }
        if (dir) {
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
