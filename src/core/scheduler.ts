import { PRIORITY_ORDER } from './types'
import type { Action, ActionSource, ActionPriority } from './types'
import type { Clock } from './clock'

export interface SchedulerOpts {
  execute: (a: Action) => Promise<void>
  clock: Clock
  perKeyCooldownMs?: number
  globalRateLimitPerSec?: number
}

interface Entry {
  source: ActionSource
  action: Action
  priority: ActionPriority
  submittedAt: number
}

export class ActionScheduler {
  private queue: Entry[] = []
  private execute: (a: Action) => Promise<void>
  private clock: Clock
  private perKeyCooldownMs: number
  private globalRate: number
  private lastKeyAt = new Map<string, number>()
  private windowStart = 0
  private windowCount = 0

  constructor(opts: SchedulerOpts) {
    this.execute = opts.execute
    this.clock = opts.clock
    this.perKeyCooldownMs = opts.perKeyCooldownMs ?? 200
    this.globalRate = opts.globalRateLimitPerSec ?? 20
  }

  submit(source: ActionSource, action: Action, priority: ActionPriority) {
    if (action.kind === 'press') {
      const k = `${source}:${action.key}`
      const last = this.lastKeyAt.get(k) ?? -Infinity
      if (this.clock.now() - last < this.perKeyCooldownMs) return
      this.lastKeyAt.set(k, this.clock.now())
    }
    this.queue.push({ source, action, priority, submittedAt: this.clock.now() })
  }

  clear(source?: ActionSource) {
    if (!source) this.queue = []
    else this.queue = this.queue.filter((e) => e.source !== source)
  }

  async tick(): Promise<void> {
    this.queue.sort((a, b) => {
      const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
      return p !== 0 ? p : a.submittedAt - b.submittedAt
    })
    while (this.queue.length) {
      const now = this.clock.now()
      if (now - this.windowStart >= 1000) {
        this.windowStart = now
        this.windowCount = 0
      }
      if (this.windowCount >= this.globalRate) break
      const entry = this.queue.shift()!
      this.windowCount++
      await this.execute(entry.action)
    }
  }
}
