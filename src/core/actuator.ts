import type { Action } from './types'
import type { InputBackend } from '@/input/index'
import type { TypedBus } from './bus'
import type { Clock } from './clock'
import { logger } from './logger'

export interface ActuatorOpts {
  backend: InputBackend
  bus: TypedBus
  clock: Clock
  getForegroundTitle: () => Promise<string | null>
  jitterMs?: number
}

export class Actuator {
  private backend: InputBackend
  private bus: TypedBus
  private clock: Clock
  private getFg: () => Promise<string | null>
  private jitter: number
  private targetPattern = ''
  private paused = false
  private aborted = false

  constructor(opts: ActuatorOpts) {
    this.backend = opts.backend
    this.bus = opts.bus
    this.clock = opts.clock
    this.getFg = opts.getForegroundTitle
    this.jitter = opts.jitterMs ?? 20
  }

  setTargetWindow(pattern: string) {
    this.targetPattern = pattern
  }

  async isGameFocused(): Promise<boolean> {
    if (!this.targetPattern) return true
    const title = await this.getFg()
    // If the OS query failed (returned null) — common on macOS when the game
    // is a fullscreen app on its own Space — assume focused. Better to be
    // permissive than silently drop every keypress. Users can correlate with
    // the test-input command to verify the game is actually receiving keys.
    if (!title) return true
    return title.toLowerCase().includes(this.targetPattern.toLowerCase())
  }

  pause(reason = 'user') {
    if (this.paused) return
    this.paused = true
    this.bus.emit('actuator.pause', { reason })
  }

  resume() {
    if (!this.paused) return
    this.paused = false
    this.bus.emit('actuator.resume', {})
  }

  abort(reason = 'user') {
    this.aborted = true
    this.backend.releaseAll().catch(() => {})
    this.bus.emit('actuator.abort', { reason })
  }

  isPaused() {
    return this.paused
  }
  isAborted() {
    return this.aborted
  }

  async execute(action: Action): Promise<void> {
    if (this.aborted) return
    if (this.paused) return
    if (action.kind === 'abort') {
      this.abort(action.reason)
      return
    }
    if (!(await this.isGameFocused())) {
      logger.warn(
        { action, target: this.targetPattern },
        'actuator: dropping action — focus check failed (target window not foreground)',
      )
      return
    }

    const start = this.clock.now()
    try {
      switch (action.kind) {
        case 'press':
          await this.maybeJitter()
          await this.backend.sendKey(action.key, action.holdMs ?? 0)
          break
        case 'combo':
          await this.backend.sendCombo(action.keys, action.interKeyMs ?? 30)
          break
        case 'move':
          await this.backend.sendMove(action.direction, action.ms)
          break
        case 'wait':
          await this.clock.sleep(action.ms)
          break
      }
      this.bus.emit('action.executed', {
        action,
        backend: 'foreground-nut',
        timing: this.clock.now() - start,
      })
    } catch (err) {
      this.bus.emit('action.error', { action, err })
    }
  }

  private async maybeJitter() {
    if (this.jitter <= 0) return
    const ms = Math.floor(Math.random() * this.jitter)
    if (ms > 0) await this.clock.sleep(ms)
  }
}
