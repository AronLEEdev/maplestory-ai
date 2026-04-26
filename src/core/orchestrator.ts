import type { GameState, Action } from './types'
import type { TypedBus } from './bus'
import type { Clock } from './clock'
import type { InputBackend } from '@/input/index'
import { ActionScheduler } from './scheduler'
import { Actuator } from './actuator'
import { RoutineRunner } from '@/routine/runner'
import type { Routine } from '@/routine/schema'
import { buildGameState, type Bounds } from '@/perception/state-builder'
import type { ReflexWorker } from '@/reflex/pixel-sampler'
import type { YoloPerception } from '@/perception/yolo'
import type { CaptureProvider } from '@/capture/index'
import type { MinimapSampler } from '@/perception/minimap'

export type RunMode = 'dry-run' | 'safe' | 'live'

export interface OrchestratorOpts {
  routine: Routine
  bus: TypedBus
  clock: Clock
  mode: RunMode
  backend: InputBackend
  perception?: { next: () => Promise<GameState | null> }
  states?: GameState[]
  getForegroundTitle: () => Promise<string | null>
  yolo?: YoloPerception
  capture?: CaptureProvider
  reflex?: ReflexWorker
  minimap?: MinimapSampler
  bounds?: Bounds
  boundsMargin?: number
  actuatorJitterMs?: number
}

export class Orchestrator {
  private scheduler: ActionScheduler
  private actuator: Actuator
  private routineRunner: RoutineRunner
  private states?: GameState[]
  private stateIdx = 0
  private mode: RunMode

  constructor(private opts: OrchestratorOpts) {
    this.mode = opts.mode
    this.actuator = new Actuator({
      backend: opts.backend,
      bus: opts.bus,
      clock: opts.clock,
      getForegroundTitle: opts.getForegroundTitle,
      jitterMs: opts.actuatorJitterMs,
    })
    this.actuator.setTargetWindow(opts.routine.window_title)
    this.scheduler = new ActionScheduler({
      execute: (a) => this.executeViaActuator(a),
      clock: opts.clock,
    })
    this.routineRunner = new RoutineRunner(opts.routine, opts.clock, (a) =>
      this.scheduler.submit('routine', a, 'routine'),
    )
    this.states = opts.states
  }

  scheduleEmergency(a: Action) {
    this.scheduler.submit('reflex', a, 'emergency')
  }

  private async executeViaActuator(a: Action): Promise<void> {
    if (this.mode === 'dry-run') {
      this.opts.bus.emit('action.executed', { action: a, backend: 'dry-run', timing: 0 })
      return
    }
    if (this.mode === 'safe') {
      if (a.kind === 'press' || a.kind === 'combo' || a.kind === 'move') {
        this.opts.bus.emit('action.executed', { action: a, backend: 'safe-blocked', timing: 0 })
        return
      }
    }
    await this.actuator.execute(a)
  }

  async runOneTick(): Promise<void> {
    if (this.opts.reflex) await this.opts.reflex.tick()
    let state: GameState | null = null
    if (this.states) {
      state = this.states[this.stateIdx++ % this.states.length]
    } else if (this.opts.yolo && this.opts.capture) {
      const buf = await this.opts.capture.captureScreen()
      const sharp = (await import('sharp')).default
      const meta = await sharp(buf).metadata()
      const [frame, minimapPos] = await Promise.all([
        this.opts.yolo.run(buf, meta.width ?? 1920, meta.height ?? 1080),
        this.opts.minimap ? this.opts.minimap.sample() : Promise.resolve(null),
      ])
      const vitals = this.opts.reflex?.current() ?? { hp: 1, mp: 1 }
      state = buildGameState(
        frame,
        vitals,
        minimapPos,
        this.opts.bounds ?? null,
        this.opts.boundsMargin ?? 10,
      )
      if (state.flags.outOfBounds) {
        this.abort('out_of_bounds')
        return
      }
    } else if (this.opts.perception) {
      state = await this.opts.perception.next()
    }
    if (!state) return
    this.opts.bus.emit('state.built', state)
    this.routineRunner.tick(state)
    await this.scheduler.tick()
  }

  pause(reason = 'user') {
    this.actuator.pause(reason)
  }
  resume() {
    this.actuator.resume()
  }
  abort(reason = 'user') {
    this.actuator.abort(reason)
  }
}
