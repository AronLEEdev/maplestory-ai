import type { GameState, Action } from './types'
import type { TypedBus } from './bus'
import type { Clock } from './clock'
import type { InputBackend } from '@/input/index'
import { ActionScheduler } from './scheduler'
import { Actuator } from './actuator'
import { RoutineRunner } from '@/routine/runner'
import type { Routine } from '@/routine/schema'
import { buildGameState, type Bounds, type CombatAnchorConfig } from '@/perception/state-builder'
import type { ReflexWorker } from '@/reflex/pixel-sampler'
import type { CaptureProvider } from '@/capture/index'
import type { MinimapSampler } from '@/perception/minimap'
import type { TemplateLibrary } from '@/perception/template-library'
import type { Rect, PerceptionFrame } from './types'
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
  templateLibrary?: TemplateLibrary
  templateThreshold?: number
  templateStride?: number
  templateSearchRegion?: Rect
  combatAnchor?: CombatAnchorConfig
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
    if (this.opts.reflex) {
      try {
        await this.opts.reflex.tick()
      } catch (err) {
        logger.warn({ err }, 'reflex.tick threw')
      }
    }
    let state: GameState | null = null
    if (this.states) {
      state = this.states[this.stateIdx++ % this.states.length]
    } else if (this.opts.capture && this.opts.templateLibrary) {
      // captureScreen returns a PNG buffer; decode to raw RGB once here.
      const png = await this.opts.capture.captureScreen()
      const sharp = (await import('sharp')).default
      const meta = await sharp(png).metadata()
      const screenW = meta.width ?? 1920
      const screenH = meta.height ?? 1080

      // Template detection. Optionally crop to a search region first.
      const lib = this.opts.templateLibrary
      const region = this.opts.templateSearchRegion
      const threshold = this.opts.templateThreshold ?? 0.75
      const stride = this.opts.templateStride ?? 2
      let haystack: Buffer
      let hw = screenW
      let hh = screenH
      if (region) {
        haystack = await sharp(png)
          .extract({ left: region.x, top: region.y, width: region.w, height: region.h })
          .removeAlpha()
          .raw()
          .toBuffer()
        hw = region.w
        hh = region.h
      } else {
        haystack = await sharp(png).removeAlpha().raw().toBuffer()
      }
      let frame: PerceptionFrame = await lib.detectFrame(haystack, hw, hh, threshold, stride)
      if (region) {
        frame = {
          ...frame,
          detections: frame.detections.map((d) => ({
            ...d,
            bbox: [d.bbox[0] + region.x, d.bbox[1] + region.y, d.bbox[2], d.bbox[3]] as [
              number,
              number,
              number,
              number,
            ],
          })),
          screenshotMeta: { width: screenW, height: screenH },
        }
      }

      let minimapPos = null
      if (this.opts.minimap) {
        try {
          minimapPos = await this.opts.minimap.sample()
        } catch (err) {
          logger.warn({ err }, 'minimap sample threw')
        }
      }
      const vitals = this.opts.reflex?.current() ?? { hp: 1, mp: 1 }
      state = buildGameState(
        frame,
        vitals,
        minimapPos,
        this.opts.bounds ?? null,
        this.opts.boundsMargin ?? 10,
        this.opts.combatAnchor ?? {},
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
  isPaused() {
    return this.actuator.isPaused()
  }
  isAborted() {
    return this.actuator.isAborted()
  }
}
