import { Command } from 'commander'
import { readFileSync, existsSync } from 'node:fs'
import YAML from 'yaml'
import 'dotenv/config'
import { Routine } from '@/routine/schema'
import { Orchestrator, type RunMode } from '@/core/orchestrator'
import { TypedBus } from '@/core/bus'
import { RealClock } from '@/core/clock'
import { ScreenshotDesktopCapture } from '@/capture/screenshot-desktop'
import { ForegroundNutBackend } from '@/input/foreground-nut'
import { getForegroundWindowTitle } from '@/core/focus'
import { HotkeyService } from '@/core/hotkeys'
import { Recorder } from '@/recorder/index'
import { analyze } from '@/analyzer/index'
import { runDoctor } from '@/doctor'
import { logger } from '@/core/logger'
import { YoloPerception } from '@/perception/yolo'
import { ReflexWorker, redPixelRatio, bluePixelRatio } from '@/reflex/pixel-sampler'
import { MinimapSampler } from '@/perception/minimap'
import type { Rect, Action } from '@/core/types'
import { defaultRegions } from '@/core/maplestory-defaults'
import { ReplayWriter } from '@/replay/writer'
import { join as pathJoin } from 'node:path'

const program = new Command()
program.name('maplestory.ai').description('Maplestory farming co-pilot').version('0.0.1')

program
  .command('doctor')
  .description('Validate environment')
  .action(async () => {
    process.exit(await runDoctor())
  })

program
  .command('record')
  .requiredOption('--name <n>', 'recording name')
  .option('--out <dir>', 'output dir', 'recordings')
  .option('--fps <n>', 'frames per sec', '5')
  .option('--width <n>', 'screen width', '1920')
  .option('--height <n>', 'screen height', '1080')
  .action(async (opts) => {
    const cap = new ScreenshotDesktopCapture()
    const clock = new RealClock()
    const fg = await getForegroundWindowTitle()
    const W = Number(opts.width)
    const H = Number(opts.height)
    const regions = defaultRegions(W, H)
    const sampleVitals = async () => {
      try {
        const [hpBuf, mpBuf] = await Promise.all([
          cap.captureRegion(regions.hp),
          cap.captureRegion(regions.mp),
        ])
        return { hp: redPixelRatio(hpBuf), mp: bluePixelRatio(mpBuf) }
      } catch {
        return { hp: 1, mp: 1 }
      }
    }
    const recorder = new Recorder({
      outDir: opts.out,
      name: opts.name,
      clock,
      capture: () => cap.captureScreen(),
      sampleVitals,
      framesPerSec: Number(opts.fps),
      onCaptureError: (err) => logger.warn({ err }, 'recorder: capture failed'),
    })
    await recorder.start({ resolution: [W, H], windowTitle: fg ?? 'MapleStory' })

    // Keystroke capture — feed every keydown/keyup into the recorder.
    // Skip F12 (the stop hotkey) so it doesn't pollute the recording.
    const { GlobalKeyboardListener } = await import('node-global-key-listener')
    const startedAt = clock.now()
    const keyListener = new GlobalKeyboardListener()
    keyListener.addListener((e) => {
      if (e.name === 'F12') return
      const type = e.state === 'DOWN' ? 'keydown' : 'keyup'
      recorder.recordKey({ type, key: String(e.name ?? ''), t: clock.now() - startedAt })
    })

    logger.info('recording... press F12 to stop')
    await new Promise<void>((resolve) => {
      const hk = new HotkeyService({
        onPauseToggle: () => {},
        onAbort: async () => {
          await recorder.stop()
          keyListener.kill()
          hk.stop()
          resolve()
        },
      })
      hk.start()
    })
    logger.info('recording saved')
  })

program
  .command('analyze <recordingDir>')
  .requiredOption('--out <path>', 'output routine YAML path')
  .option('--api', 'use Anthropic API (requires ANTHROPIC_API_KEY); default emits a Claude Code prompt bundle instead')
  .action(async (recordingDir, opts) => {
    if (opts.api) {
      const key = process.env.ANTHROPIC_API_KEY
      if (!key) {
        logger.error('--api flag set but ANTHROPIC_API_KEY missing')
        process.exit(1)
      }
      await analyze({ recordingDir, outRoutinePath: opts.out, apiKey: key })
      logger.info(`wrote ${opts.out}`)
      return
    }
    const { writePromptBundle } = await import('@/analyzer/prompt-bundle')
    const { bundlePath, framesSampled } = writePromptBundle({
      recordingDir,
      outRoutinePath: opts.out,
    })
    logger.info({ bundlePath, framesSampled }, 'analyze: prompt bundle ready')
    console.log(`
Next step — let Claude Code do the analysis:

  1. Open Claude Code in this repo (the \`claude\` CLI).
  2. Run the slash command:    /analyze-recording ${bundlePath}
     (or just say: "Read ${bundlePath} and follow it.")
  3. Claude Code will read the frames + logs and write ${opts.out}.
  4. Review the YAML, remove \`unreviewed: true\`, then dry-run:
       npm run dev -- run ${opts.out} --mode dry-run
`)
  })

program
  .command('run <routinePath>')
  .option('--mode <mode>', 'dry-run|safe|live', 'dry-run')
  .action(async (routinePath, opts) => {
    if (!existsSync(routinePath)) {
      logger.error('routine not found')
      process.exit(1)
    }
    const obj = YAML.parse(readFileSync(routinePath, 'utf8'))
    if (obj.unreviewed) {
      logger.error('routine marked unreviewed: true — review and remove flag first')
      process.exit(1)
    }
    const routine = Routine.parse(obj)
    const bus = new TypedBus()
    const clock = new RealClock()
    const backend = new ForegroundNutBackend()
    const cap = new ScreenshotDesktopCapture()
    const yolo = new YoloPerception({
      modelPath: `models/${routine.perception.model}.onnx`,
      classes: routine.perception.classes,
      confidenceThreshold: routine.perception.confidence_threshold,
    })
    if (existsSync(`models/${routine.perception.model}.onnx`)) {
      await yolo.load()
    } else {
      logger.warn('YOLO model missing — perception disabled')
    }

    const minimapColor = routine.minimap_player_color ?? {
      rgb: [240, 220, 60] as [number, number, number],
      tolerance: 30,
    }
    const minimap = new MinimapSampler({
      captureRegion: (r) => cap.captureRegion(r),
      region: routine.regions.minimap,
      matcher: minimapColor,
    })

    // Reflex needs a reference to the Orchestrator's emergency-submit closure;
    // we forward via a mutable holder so the Orchestrator can be constructed once.
    const emergency: { fn: (a: Action) => void } = { fn: () => {} }
    const reflex = new ReflexWorker({
      clock,
      submit: (a) => emergency.fn(a),
      checks: routine.reflex.map((r) => ({
        region: r.region,
        metric: r.metric,
        below: r.below,
        cooldownMs: r.cooldown_ms,
        action: r.action,
      })),
      sample: async (regionName) => {
        const r = (routine.regions as Record<string, Rect>)[regionName]
        if (!r) return Buffer.alloc(0)
        return cap.captureRegion(r)
      },
    })

    const o = new Orchestrator({
      routine,
      bus,
      clock,
      mode: opts.mode as RunMode,
      backend,
      perception: { next: async () => null },
      getForegroundTitle: getForegroundWindowTitle,
      yolo,
      capture: cap,
      reflex,
      minimap,
      bounds: routine.bounds
        ? {
            x: routine.bounds.x as [number, number],
            y: routine.bounds.y as [number, number],
          }
        : undefined,
    })
    emergency.fn = (a) => o.scheduleEmergency(a)

    let stop = false
    const hk = new HotkeyService({
      onPauseToggle: () => o.pause('hotkey'),
      onAbort: () => {
        o.abort('hotkey')
        stop = true
      },
    })
    bus.on('action.error', ({ action, err }) =>
      logger.warn({ action, err }, 'actuator: backend threw'),
    )

    // Wire ReplayWriter — capture state/action/event stream for postmortem.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const replayDir = pathJoin('recordings', 'runs', stamp)
    const replay = new ReplayWriter(replayDir)
    bus.on('state.built', (s) => replay.write('states', s))
    bus.on('action.executed', (e) => replay.write('actions', e))
    bus.on('action.error', (e) => replay.write('actions', e))
    bus.on('actuator.pause', (e) => replay.write('events', { kind: 'pause', ...e }))
    bus.on('actuator.resume', () => replay.write('events', { kind: 'resume' }))
    bus.on('actuator.abort', (e) => replay.write('events', { kind: 'abort', ...e }))
    logger.info({ replayDir }, 'replay artifact dir')

    hk.start()
    logger.info(`running in ${opts.mode}. F10 pause, F12 abort`)
    let consecutiveErrors = 0
    while (!stop) {
      if (o.isPaused()) {
        await new Promise((r) => setTimeout(r, 200))
        continue
      }
      try {
        await o.runOneTick()
        consecutiveErrors = 0
      } catch (err) {
        consecutiveErrors++
        logger.warn({ err, consecutiveErrors }, 'tick failed; continuing')
        if (consecutiveErrors >= 10) {
          logger.error('10 consecutive tick failures — aborting run')
          o.abort('repeated_failures')
          break
        }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    hk.stop()
    await replay.close()
  })

program.parseAsync(process.argv)
