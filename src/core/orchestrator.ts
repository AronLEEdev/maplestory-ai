import type { GameState, Action, ActionSource, ActionPriority } from './types'
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
  templateMaxPerClass?: number
  templateSearchRegion?: Rect
  /** ±y px around the combat anchor's y to crop the haystack to. With
   *  native-scale templates this slab cropping is what keeps ZNCC under
   *  the per-tick budget. */
  templateAttackBandY?: number
  combatAnchor?: CombatAnchorConfig
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
    } else if (this.opts.capture && this.opts.templateLibrary) {
      const tCapStart = this.opts.clock.now()
      // captureScreen returns a PNG buffer; decode to raw RGB once here.
      const png = await this.opts.capture.captureScreen()
      log({ bytes: png.length, ms: this.opts.clock.now() - tCapStart }, 'tick: captureScreen done')
      const tSharp = this.opts.clock.now()
      const sharp = (await import('sharp')).default
      const meta = await sharp(png).metadata()
      const screenW = meta.width ?? 1920
      const screenH = meta.height ?? 1080
      const tCapMs = this.opts.clock.now() - tCapStart
      log({ screenW, screenH, ms: this.opts.clock.now() - tSharp }, 'tick: sharp meta done')

      // Template detection. v1.4.1: detection scans the full search_region
      // (gameWindow). The previous attack_band_y slab was a hard pre-detection
      // visibility gate — any combat-anchor error made nearby mobs invisible
      // to ZNCC with no log signal. The y-band effect is preserved through
      // combat_anchor.y_band as a post-filter on enemies in state-builder.
      const lib = this.opts.templateLibrary
      const region = this.opts.templateSearchRegion
      const threshold = this.opts.templateThreshold ?? 0.5
      const stride = this.opts.templateStride ?? 4
      const maxPerClass = this.opts.templateMaxPerClass ?? 8
      if (this.opts.templateAttackBandY) {
        log({ attackBandY: this.opts.templateAttackBandY }, 'tick: attack_band_y is deprecated and ignored — use combat_anchor.y_band')
      }

      // Hard cap on haystack long edge as a safety bound for unusually large
      // game windows. Set above typical retina game-window backing pixels
      // (1918) so a Mac retina capture of a 1980-logical game window stays
      // at native scale — any rescale here introduces a template/haystack
      // scale mismatch and ZNCC scores collapse to noise.
      const HAYSTACK_LONG_EDGE_CAP = 2400
      const baseW = region?.w ?? screenW
      const baseH = region?.h ?? screenH
      const longEdge = Math.max(baseW, baseH)
      const scale = longEdge > HAYSTACK_LONG_EDGE_CAP ? longEdge / HAYSTACK_LONG_EDGE_CAP : 1

      // Crop only to the search_region (gameWindow).
      const extractX = region?.x ?? 0
      const extractY = region?.y ?? 0
      const extractW = region?.w ?? screenW
      const extractH = region?.h ?? screenH

      let hw = extractW
      let hh = extractH
      const tDecode = this.opts.clock.now()
      let pipeline = sharp(png).extract({
        left: extractX,
        top: extractY,
        width: extractW,
        height: extractH,
      })
      if (scale > 1) {
        const newW = Math.floor(hw / scale)
        const newH = Math.floor(hh / scale)
        pipeline = pipeline.resize({ width: newW, height: newH, fit: 'fill' })
        hw = newW
        hh = newH
      }
      const haystack: Buffer = await pipeline.removeAlpha().raw().toBuffer()
      log(
        { hw, hh, bytes: haystack.length, scale, extractX, extractY, ms: this.opts.clock.now() - tDecode },
        'tick: sharp raw decode done',
      )
      const tDetStart = this.opts.clock.now()
      const { frame: rawFrame, diag } = await lib.detectFrame(haystack, hw, hh, threshold, stride, maxPerClass)
      let frame: PerceptionFrame = rawFrame
      const tDetMs = this.opts.clock.now() - tDetStart
      log(
        { detections: frame.detections.length, ms: tDetMs, diag },
        'tick: detect done',
      )
      // Noisy-template detector: a template producing way more raw matches
      // than its peers is almost always cropped on non-distinctive pixels and
      // will flood `mobs_in_range` with false positives. Warn loudly so the
      // user knows which template to recapture.
      const noisyCutoff = maxPerClass * 4
      for (const d of diag) {
        if (d.matchesAboveThreshold > noisyCutoff) {
          logger.warn(
            { class: d.class, variant: d.variant, raw: d.matchesAboveThreshold, capPerClass: maxPerClass },
            'perception: template produced excessive matches — likely a non-distinctive crop. Recalibrate this sprite.',
          )
        }
      }
      // Map detection bboxes back into native screen coordinates.
      // The extract uses (extractX, extractY) as origin and scale is applied
      // uniformly, so reverse both transforms here.
      frame = {
        ...frame,
        detections: frame.detections.map((d) => {
          const [x, y, w, h] = d.bbox
          const nx = x * scale + extractX
          const ny = y * scale + extractY
          return {
            ...d,
            bbox: [nx, ny, w * scale, h * scale] as [number, number, number, number],
          }
        }),
        screenshotMeta: { width: screenW, height: screenH },
      }

      this.opts.bus.emit('perception.tick', {
        captureMs: tCapMs,
        detectMs: tDetMs,
        detections: frame.detections.length,
      })
      let minimapPos = null
      if (this.opts.minimap) {
        const t0 = this.opts.clock.now()
        try {
          minimapPos = await this.opts.minimap.sample()
          log(
            { minimapPos, ms: this.opts.clock.now() - t0 },
            'tick: minimap sample done',
          )
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
