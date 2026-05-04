import type { GameState, Action, ActionSource, ActionPriority } from './types'
import type { TypedBus } from './bus'
import type { Clock } from './clock'
import type { InputBackend } from '@/input/index'
import { ActionScheduler } from './scheduler'
import { Actuator } from './actuator'
import { RoutineRunner } from '@/routine/runner'
import type { Routine } from '@/routine/schema'
import { buildGameState, PlayerTracker, type Bounds } from '@/perception/state-builder'
import type { ReflexWorker } from '@/reflex/pixel-sampler'
import type { CaptureProvider } from '@/capture/index'
import type { MinimapSampler } from '@/perception/minimap'
import type { YoloDetector, YoloDetection } from '@/perception/yolo'
import type { Rect } from './types'
import { ReplayPlayer } from '@/replay/player'
import type { Recording } from '@/replay/format'
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
  /** YOLO detector — when set, runs every tick. When absent, the runtime is
   *  in stub mode (no mob/player detections; movement + reflex still work). */
  yolo?: YoloDetector
  /** game_window rect from the routine — passed to YoloDetector.detect for
   *  both cropping the input and remapping bboxes to display-space. */
  gameWindow?: Rect
  /** Recording — when set, drives keypresses from a replay instead of the
   *  rotation/movement engine. detection_mode='replay' uses this. The
   *  orchestrator builds the ReplayPlayer internally so it can route the
   *  player's emit() through its own ActionScheduler. */
  replayRecording?: Recording
}

export class Orchestrator {
  private scheduler: ActionScheduler
  private actuator: Actuator
  private routineRunner: RoutineRunner
  private replayPlayer?: ReplayPlayer
  private states?: GameState[]
  private stateIdx = 0
  private mode: RunMode
  private tickIndex = 0
  private playerTracker = new PlayerTracker()
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
    if (opts.replayRecording) {
      this.replayPlayer = new ReplayPlayer({
        recording: opts.replayRecording,
        clock: opts.clock,
        emit: (a) => this.scheduler.submit('routine', a, 'routine'),
        loop: true,
      })
      this.replayPlayer.start()
    }
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
      // v2 perception pipeline:
      //   1. capture full display
      //   2. YOLO infers player + mobs (game-window-cropped haystack)
      //   3. minimap sampler reads player dot from minimap region
      //   4. reflex worker samples HP/MP — already running
      //   5. fuse into BotState
      const tCapStart = this.opts.clock.now()
      const png = await this.opts.capture.captureScreen()
      const tCapMs = this.opts.clock.now() - tCapStart
      log({ bytes: png.length, ms: tCapMs }, 'tick: captureScreen done')

      // Run YOLO + minimap in parallel — they hit disjoint regions and
      // disjoint compute paths.
      const tDetStart = this.opts.clock.now()
      const [detections, minimapPos] = await Promise.all([
        this.runYolo(png),
        this.opts.minimap.sample().catch((err) => {
          logger.warn({ err }, 'minimap sample threw')
          return null
        }),
      ])
      const tDetMs = this.opts.clock.now() - tDetStart
      log(
        { detections: detections.length, minimapPos, ms: tDetMs },
        'tick: yolo + minimap done',
      )

      this.opts.bus.emit('perception.tick', {
        captureMs: tCapMs,
        detectMs: tDetMs,
        detections: detections.length,
      })

      const vitals = this.opts.reflex?.current() ?? { hp: 1, mp: 1 }
      state = buildGameState({
        detections,
        tracker: this.playerTracker,
        vitals,
        minimapPos,
        bounds: this.opts.bounds ?? null,
        boundsMargin: this.opts.boundsMargin ?? 10,
        timestamp: this.opts.clock.now(),
      })
      if (!state.nav.boundsOk) {
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
    // Replay mode: ReplayPlayer drives actions; routine runner stays a no-op
    // (the routine yaml has empty rotation + movement). Reflex still fires
    // via scheduleEmergency in parallel.
    if (this.replayPlayer) {
      this.replayPlayer.tick()
      if (this.replayPlayer.isDone()) {
        logger.info('replay: recording complete — aborting (loop=false)')
        this.abort('replay_done')
        return
      }
    } else {
      this.routineRunner.tick(state)
    }
    await this.scheduler.tick()
    log({ ms: this.opts.clock.now() - tickStartedAt }, 'tick: complete')
    this.tickIndex++
  }

  /** Run YOLO inference if available, swallow errors so a bad model file
   *  doesn't crash the run loop. Returns [] in stub mode (no detector). */
  private async runYolo(png: Buffer): Promise<YoloDetection[]> {
    if (!this.opts.yolo) return []
    try {
      return await this.opts.yolo.detect(png, this.opts.gameWindow)
    } catch (err) {
      logger.warn({ err }, 'yolo: detect threw — emitting empty detections this tick')
      return []
    }
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
