import type { GameState, Action, ActionSource, ActionPriority } from './types'
import type { TypedBus } from './bus'
import type { Clock } from './clock'
import type { InputBackend } from '@/input/index'
import { ActionScheduler } from './scheduler'
import { Actuator } from './actuator'
import { RoutineRunner } from '@/routine/runner'
import type { Routine } from '@/routine/schema'
import { buildGameState, type Bounds } from '@/perception/state-builder'
import type { ReflexWorker } from '@/reflex/pixel-sampler'
import type { CaptureProvider } from '@/capture/index'
import type { MinimapSampler } from '@/perception/minimap'
import type { PerceptionFrame } from './types'
import { logger } from './logger'

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
  private tickIndex = 0
  /** Log every internal step at INFO for the first N ticks so silent hangs
   *  are pinpoint-localizable. After that the level drops to debug. */
  private static readonly VERBOSE_TICKS = 3

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
      execute: (a, source, priority) => this.executeViaActuator(a, source, priority),
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

  private async executeViaActuator(
    a: Action,
    _source: ActionSource,
    priority: ActionPriority,
  ): Promise<void> {
    if (this.mode === 'dry-run') {
      this.opts.bus.emit('action.executed', { action: a, backend: 'dry-run', timing: 0 })
      return
    }
    // Safe mode: only emergency-priority actions (Reflex pots, abort) get
    // forwarded to the OS. Routine + control + background priorities are
    // logged but blocked. This lets the user verify pots work without the
    // bot also moving / attacking.
    if (this.mode === 'safe' && priority !== 'emergency') {
      this.opts.bus.emit('action.executed', { action: a, backend: 'safe-blocked', timing: 0 })
      return
    }
    await this.actuator.execute(a)
  }

  async runOneTick(): Promise<void> {
    const verbose = this.tickIndex < Orchestrator.VERBOSE_TICKS
    const log = verbose ? logger.info.bind(logger) : logger.debug.bind(logger)
    const tickStartedAt = this.opts.clock.now()
    log({ tick: this.tickIndex }, 'tick: enter')
    if (this.opts.reflex) {
      const t0 = this.opts.clock.now()
      try {
        await this.opts.reflex.tick()
        log({ ms: this.opts.clock.now() - t0 }, 'tick: reflex done')
      } catch (err) {
        logger.warn({ err }, 'reflex.tick threw')
      }
    }
    let state: GameState | null = null
    if (this.states) {
      state = this.states[this.stateIdx++ % this.states.length]
    } else if (this.opts.capture && this.opts.minimap) {
      // v2 Phase 1: perception is minimap + reflex only. YOLO inference
      // module hooks in here in phase 5b. We still capture the screen so
      // minimap.sample() can pull its region from the latest frame, but no
      // mob detection happens — `enemies` stays empty.
      const tCapStart = this.opts.clock.now()
      const png = await this.opts.capture.captureScreen()
      log({ bytes: png.length, ms: this.opts.clock.now() - tCapStart }, 'tick: captureScreen done')
      const sharp = (await import('sharp')).default
      const meta = await sharp(png).metadata()
      const screenW = meta.width ?? 1920
      const screenH = meta.height ?? 1080
      const tCapMs = this.opts.clock.now() - tCapStart

      const emptyFrame: PerceptionFrame = {
        timestamp: Date.now(),
        detections: [],
        screenshotMeta: { width: screenW, height: screenH },
        overallConfidence: 0,
      }
      this.opts.bus.emit('perception.tick', {
        captureMs: tCapMs,
        detectMs: 0,
        detections: 0,
      })

      let minimapPos = null
      const t0 = this.opts.clock.now()
      try {
        minimapPos = await this.opts.minimap.sample()
        log({ minimapPos, ms: this.opts.clock.now() - t0 }, 'tick: minimap sample done')
      } catch (err) {
        logger.warn({ err }, 'minimap sample threw')
      }
      const vitals = this.opts.reflex?.current() ?? { hp: 1, mp: 1 }
      state = buildGameState(
        emptyFrame,
        vitals,
        minimapPos,
        this.opts.bounds ?? null,
        this.opts.boundsMargin ?? 10,
      )
      if (state.flags.outOfBounds) {
        logger.warn(
          { minimapPos, bounds: this.opts.bounds },
          'orchestrator: minimap pos out of bounds — aborting',
        )
        this.abort('out_of_bounds')
        return
      }
    } else if (this.opts.perception) {
      state = await this.opts.perception.next()
    }
    if (!state) return
    this.opts.bus.emit('state.built', state)
    log({ ms: this.opts.clock.now() - tickStartedAt }, 'tick: state built + emitted')
    this.routineRunner.tick(state)
    await this.scheduler.tick()
    log({ ms: this.opts.clock.now() - tickStartedAt }, 'tick: complete')
    this.tickIndex++
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
  isPaused() {
    return this.actuator.isPaused()
  }
  isAborted() {
    return this.actuator.isAborted()
  }
}
