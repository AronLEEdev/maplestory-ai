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
import { ReflexWorker, fillRatio } from '@/reflex/pixel-sampler'
import { MinimapSampler } from '@/perception/minimap'
import type { Rect, Action, GameState } from '@/core/types'
import { defaultRegions } from '@/core/maplestory-defaults'
import { ReplayWriter } from '@/replay/writer'
import { join as pathJoin } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { startCalibrateServer } from '@/calibrate/server'
import { ReplayRecorder } from '@/replay/recorder'
import { captureFrames, parseDuration as parseDurationMs } from '@/dataset/capture'
import { startLabelerServer, readFrameList } from '@/dataset/labeler'
import { exec } from 'node:child_process'

const program = new Command()
program.name('maplestory.ai').description('Maplestory farming co-pilot').version('0.0.1')

program
  .command('doctor')
  .description('Validate environment')
  .action(async () => {
    process.exit(await runDoctor())
  })

program
  .command('test-input')
  .description('Send F2 / F3 / F4 to whatever window is currently focused. In Maplestory these trigger funny faces — visible proof keypresses reach the game.')
  .option('--keys <list>', 'comma-separated keys to send', 'F2,F3,F4')
  .option('--gap <ms>', 'ms between presses', '1500')
  .option('--countdown <s>', 'seconds to wait so you can focus the game', '5')
  .action(async (opts) => {
    const keys = String(opts.keys)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const gap = Number(opts.gap)
    const countdown = Number(opts.countdown)
    const backend = new ForegroundNutBackend()

    logger.info({ keys, gap }, 'test-input: focus the game window NOW')
    for (let i = countdown; i > 0; i--) {
      console.log(`  ...${i}`)
      await new Promise((r) => setTimeout(r, 1000))
    }
    const fg = await getForegroundWindowTitle()
    logger.info({ foregroundWindow: fg }, 'sending keys now')

    for (const key of keys) {
      const t0 = Date.now()
      try {
        await backend.sendKey(key, 50)
        logger.info(
          { key, ms: Date.now() - t0 },
          'press dispatched (no exception from nut.js)',
        )
      } catch (err) {
        logger.error({ key, err }, 'press FAILED — nut.js threw')
      }
      await new Promise((r) => setTimeout(r, gap))
    }
    logger.info('done — check the game. Did you see the faces?')
  })

program
  .command('inspect <routinePath>')
  .description('One-shot capture: dump the full frame + each region crop + every template so you can eyeball region coords')
  .option('--out <dir>', 'output dir', 'inspect')
  .action(async (routinePath, opts) => {
    if (!existsSync(routinePath)) {
      logger.error({ routinePath }, 'routine not found')
      process.exit(1)
    }
    const obj = YAML.parse(readFileSync(routinePath, 'utf8'))
    let routine: Routine
    try {
      routine = Routine.parse(obj)
    } catch (err) {
      logger.error({ err }, 'routine schema validation failed')
      process.exit(1)
    }
    const sharp = (await import('sharp')).default
    const fs = await import('node:fs/promises')

    mkdirSync(opts.out, { recursive: true })

    const cap = new ScreenshotDesktopCapture()
    logger.info('capturing screen now — focus the game first if you want a meaningful frame')
    await new Promise((r) => setTimeout(r, 500))
    const png = await cap.captureScreen()
    const meta = await sharp(png).metadata()
    const W = meta.width ?? 0
    const H = meta.height ?? 0
    logger.info({ W, H, bytes: png.length }, 'capture done')

    // 1. Dump full frame.
    await fs.writeFile(pathJoin(opts.out, 'full.png'), png)

    // 2. Dump each routine region.
    for (const [name, rect] of Object.entries(routine.regions) as [string, Rect][]) {
      if (!rect) continue
      try {
        await sharp(png)
          .extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h })
          .toFile(pathJoin(opts.out, `region-${name}.png`))
        logger.info({ name, rect }, 'wrote region crop')
      } catch (err) {
        logger.warn({ name, rect, err }, 'region extract failed (out of bounds?)')
      }
    }

    // 4. Run YOLO once (if model exists) and overlay detections + regions.
    type DetVis = { class: string; bbox: [number, number, number, number]; confidence: number }
    let yoloDets: DetVis[] = []
    let yoloMs = 0
    if (routine.perception.model_path && existsSync(routine.perception.model_path)) {
      try {
        const { YoloDetector } = await import('@/perception/yolo')
        const det = new YoloDetector({
          modelPath: routine.perception.model_path,
          confidenceThreshold: routine.perception.confidence_threshold,
        })
        const t0 = Date.now()
        const gw = obj.game_window as Rect | undefined
        yoloDets = await det.detect(png, gw)
        yoloMs = Date.now() - t0
        logger.info(
          { detections: yoloDets.length, ms: yoloMs },
          'inspect: YOLO detection done',
        )
      } catch (err) {
        logger.warn({ err }, 'inspect: YOLO inference failed — overlay will skip detections')
      }
    } else {
      logger.warn(
        { modelPath: routine.perception.model_path },
        'inspect: no model_path or file missing — skipping YOLO overlay',
      )
    }

    // 5. Annotated full-frame: regions in red, YOLO mob detections in
    //    cyan, YOLO player detection in lime.
    try {
      const svgRects = (Object.entries(routine.regions) as [string, Rect][])
        .filter(([, r]) => r != null)
        .map(([name, r]) => {
          return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" stroke="red" stroke-width="3" fill="none"/><text x="${r.x + 4}" y="${r.y - 4}" font-size="20" fill="red" font-family="sans-serif">${name}</text>`
        })
        .join('\n')

      const detSvg = yoloDets
        .map((d) => {
          const color = d.class === 'player' ? '#7f7' : '#0ff'
          const [x, y, w, h] = d.bbox
          return (
            `<rect x="${x}" y="${y}" width="${w}" height="${h}" stroke="${color}" stroke-width="3" fill="none"/>` +
            `<text x="${x}" y="${y + h + 18}" font-size="14" fill="${color}" font-family="ui-monospace, monospace" font-weight="600">${d.class} ${d.confidence.toFixed(2)}</text>`
          )
        })
        .join('\n')

      const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svgRects}${detSvg}</svg>`
      await sharp(png)
        .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
        .toFile(pathJoin(opts.out, 'full-annotated.png'))
      logger.info('wrote full-annotated.png')
    } catch (err) {
      logger.warn({ err }, 'annotated overlay failed')
    }

    console.log(`
inspect output → ${opts.out}/

Open in Finder / Preview:
  - full.png            full screen capture (look at this first — does it show the GAME?)
  - full-annotated.png  capture with overlays
  - region-hp.png       cropped HP bar (should look like a red bar)
  - region-mp.png       cropped MP bar (should look like a blue bar)
  - region-minimap.png  cropped minimap (should look like the minimap)

  In full-annotated.png:
  - red rectangles  = HP / MP / minimap regions; should hug each UI element
  - lime box        = YOLO player detection (with confidence label)
  - cyan box        = YOLO mob detection (with confidence label)
  YOLO ran in ${yoloMs} ms, ${yoloDets.length} detections (model: ${routine.perception.model_path ?? 'absent'})
`)
  })

program
  .command('calibrate <map>')
  .description(
    'Capture screen + open browser canvas to calibrate regions, bounds, sprites, waypoints — writes routines/<map>.yaml + data/templates/<map>/ in one go',
  )
  .option('--countdown <s>', 'seconds to wait before capture so you can focus the game', '5')
  .option('--port <n>', 'fastify port (0 = random)', '0')
  .action(async (map, opts) => {
    const cap = new ScreenshotDesktopCapture()
    const countdown = Number(opts.countdown)
    if (countdown > 0) {
      logger.info(`focus the Maplestory window — capturing in ${countdown}s`)
      for (let i = countdown; i > 0; i--) {
        console.log(`  ...${i}`)
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    const png = await cap.captureScreen()
    logger.info({ bytes: png.length }, 'screen captured — starting calibrate server')

    let exitCode = 0
    await new Promise<void>((resolve, reject) => {
      startCalibrateServer({
        map,
        screenshotPng: png,
        port: Number(opts.port),
        onSave: async (result) => {
          logger.info(result, 'calibrate: saved')
          const mapName = map
          const yoloNext = `Next (YOLO mode — needs training data):
  npm run dev -- capture ${mapName} --duration 10m --routine ${result.routinePath}
  npm run dev -- label ${mapName}                # label ~50 frames
  python python/train.py ${mapName} --quick      # bootstrap train
  python python/export_onnx.py ${mapName}
  npm run dev -- label ${mapName}                # predict-assist remaining frames
  python python/train.py ${mapName}              # final train (80 epochs)
  python python/export_onnx.py ${mapName}
  npm run dev -- run ${result.routinePath} --mode dry-run`
          const noneNext = `Next (minimap-only mode — ready to run, no training):
  npm run dev -- inspect ${result.routinePath}                    # verify regions
  npm run dev -- run ${result.routinePath} --mode dry-run         # state log
  npm run dev -- run ${result.routinePath} --mode safe            # pots only
  npm run dev -- run ${result.routinePath} --mode live            # full bot`
          const replayNext = `Next (replay mode — record once, bot replays):
  npm run dev -- record-replay ${mapName}      # F12 stops, saves replays/${mapName}/recording.json
  npm run dev -- run ${result.routinePath} --mode live`
          console.log(`
Calibration complete:
  routine:        ${result.routinePath}
  detection mode: ${result.detectionMode}
${result.warnings.length ? '\nwarnings:\n  - ' + result.warnings.join('\n  - ') + '\n' : ''}
${result.detectionMode === 'replay' ? replayNext : result.detectionMode === 'none' ? noneNext : yoloNext}
`)
          await handle.close()
          resolve()
        },
        onCancel: async () => {
          logger.info('calibrate: cancelled by user')
          exitCode = 1
          await handle.close()
          resolve()
        },
      })
        .then((h) => {
          handle = h
          // Auto-open the URL in the user's default browser.
          const opener =
            process.platform === 'darwin'
              ? 'open'
              : process.platform === 'win32'
                ? 'start ""'
                : 'xdg-open'
          exec(`${opener} ${h.url}`, () => {})
          console.log(`
Calibration server: ${h.url}
(opening in browser; if it doesn't appear, copy the URL manually)
`)
        })
        .catch(reject)
      let handle: { close: () => Promise<void> } = { close: async () => {} }
    })
    process.exit(exitCode)
  })

program
  .command('init <map>')
  .description('Scaffold data/sprites-raw/<map>/<mob>/ folders for the user to fill')
  .option('--mobs <list>', 'comma-separated mob folder names (e.g. green_snail,orange_mushroom)')
  .option('--with-player', 'also create a _player/ folder for the player template (optional)')
  .option('--root <dir>', 'override sprites-raw root', 'data/sprites-raw')
  .action((map, opts) => {
    const root = pathJoin(opts.root, map)
    if (!opts.mobs) {
      logger.error(
        { example: 'npm run dev -- init henesys --mobs green_snail,orange_mushroom --with-player' },
        'init: --mobs is required',
      )
      process.exit(1)
    }
    const mobNames = String(opts.mobs)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (mobNames.length === 0) {
      logger.error('init: --mobs is empty after parsing')
      process.exit(1)
    }
    mkdirSync(root, { recursive: true })
    const created: string[] = []
    for (const m of mobNames) {
      if (m.startsWith('_')) {
        logger.warn(
          { name: m },
          'init: mob names cannot start with underscore (reserved). Skipping.',
        )
        continue
      }
      const dir = pathJoin(root, m)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        pathJoin(dir, 'README.md'),
        `# ${m}\n\nDrop sprite PNGs into this folder.\n\nRecommended files:\n- stand.png  (or idle.png) — most important; default template\n- move.png   — recommended\n- attack.png — optional\n\nSource: https://maplestory.io/api/<region>/<ver>/mob (search for "${m}")\n`,
      )
      created.push(dir)
    }
    if (opts.withPlayer) {
      const dir = pathJoin(root, '_player')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        pathJoin(dir, 'README.md'),
        `# _player (reserved)\n\nDrop a player snapshot here for tighter combat distance.\nWithout it the bot uses screen-center as the combat anchor.\n\nRecommended file:\n- stand.png\n`,
      )
      created.push(dir)
    }
    writeFileSync(
      pathJoin(root, 'README.md'),
      `# ${map} sprites\n\nFill each subfolder with PNGs from maplestory.io (or any source).\n\nThen run:\n  npm run dev -- import-sprites ${map}\n\nThis will copy + validate the PNGs into data/templates/${map}/manifest.json\nfor the runtime template library.\n`,
    )
    logger.info({ root, created }, 'init: scaffold ready')
    console.log(`
Scaffold created at ${root}/

Folders created:
${created.map((d) => `  - ${d}`).join('\n')}

Next steps:
  1. Drop PNG sprites into each <mob>/ folder (stand.png, move.png, etc.).
  2. (Optional) Drop a player snapshot to ${root}/_player/stand.png.
  3. Run:  npm run dev -- import-sprites ${map}
`)
  })

// `import-sprites` command removed in v2 — perception switched from ZNCC
// templates to YOLO. Frame capture + canvas labeling + python training is
// now the per-map workflow (see `capture <map>` + canvas labeler).

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
    logger.info({ foregroundWindow: fg }, 'recording will run while this window is focused')
    const W = Number(opts.width)
    const H = Number(opts.height)
    const regions = defaultRegions(W, H)
    const sampleVitals = async () => {
      try {
        const [hpBuf, mpBuf] = await Promise.all([
          cap.captureRegion(regions.hp),
          cap.captureRegion(regions.mp),
        ])
        // Color-agnostic: count "lit" pixels (luminance >= 80) regardless of
        // bar color. Works for red HP, blue/cyan/magenta MP across MS classes.
        return { hp: fillRatio(hpBuf), mp: fillRatio(mpBuf) }
      } catch (err) {
        logger.warn({ err }, 'recorder: vitals sample failed')
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
  .command('capture <map>')
  .description('Frame-grab loop: saves PNGs to data/dataset/<map>/raw/ for YOLO labeling. Skips frames when the game is not foreground.')
  .option('--duration <d>', 'capture window (e.g. 30s, 10m, 1h)', '10m')
  .option('--fps <n>', 'frames per second', '2')
  .option('--no-window-filter', 'capture every frame regardless of foreground app')
  .option('--routine <path>', 'use this routine.yaml to crop frames to its game_window')
  .option('--out <dir>', 'output dir (default: data/dataset/<map>/raw)')
  .action(async (map, opts) => {
    const durationMs = parseDurationMs(String(opts.duration))
    const fps = Number(opts.fps)
    if (!Number.isFinite(fps) || fps <= 0 || fps > 30) {
      logger.error({ fps: opts.fps }, 'fps must be in (0, 30]')
      process.exit(1)
    }
    const intervalMs = Math.round(1000 / fps)

    let gameWindow: { x: number; y: number; w: number; h: number } | undefined
    let windowTitle: string | undefined = 'maplestory'
    if (opts.routine) {
      if (!existsSync(opts.routine)) {
        logger.error({ routine: opts.routine }, 'routine not found')
        process.exit(1)
      }
      const obj = YAML.parse(readFileSync(opts.routine, 'utf8'))
      try {
        const routine = Routine.parse(obj)
        gameWindow = (obj.game_window as { x: number; y: number; w: number; h: number } | undefined) ?? undefined
        windowTitle = routine.window_title || windowTitle
        if (routine.perception.detection_mode === 'none') {
          logger.warn(
            'routine.perception.detection_mode is "none" — capture is unnecessary in minimap-only mode. Continuing anyway in case you plan to switch modes later.',
          )
        }
      } catch (err) {
        logger.warn({ err }, 'capture: routine parse failed — falling back to full-display frames')
      }
    }
    if (opts.windowFilter === false) windowTitle = undefined

    const cap = new ScreenshotDesktopCapture()

    let stopRequested = false
    process.on('SIGINT', () => {
      logger.info('capture: SIGINT — stopping after current frame')
      stopRequested = true
    })

    console.log(`
capture starting:
  map         = ${map}
  duration    = ${opts.duration}  (${durationMs} ms)
  fps         = ${fps}  (every ${intervalMs} ms)
  outDir      = ${opts.out ?? pathJoin('data', 'dataset', map, 'raw')}
  windowFilter= ${windowTitle ?? '(off — captures everything)'}
  cropToGame  = ${gameWindow ? 'yes (from routine.game_window)' : 'no'}

Focus your game now. Press Ctrl-C to stop early.
`)

    const summary = await captureFrames({
      map,
      capture: cap,
      intervalMs,
      durationMs,
      windowTitle,
      gameWindow,
      outDir: opts.out,
      shouldStop: () => stopRequested,
    })
    console.log(`
capture done:
  saved             = ${summary.saved} frames
  skipped (no focus) = ${summary.skippedNotFocused}
  elapsed            = ${(summary.durationMs / 1000).toFixed(1)}s
  output             = ${summary.outDir}/

Next: open the calibrator labeler to draw player/mob boxes on these frames.
`)
  })

program
  .command('record-replay <map>')
  .description('Record a keystroke timeline for blind replay (auto-maple style). Saves to replays/<map>/recording.json. F12 stops.')
  .option('--out <path>', 'override output path (default: replays/<map>/recording.json)')
  .option('--countdown <s>', 'seconds to wait so you can focus the game', '5')
  .action(async (map, opts) => {
    const outPath = (opts.out as string | undefined) ?? pathJoin('replays', map, 'recording.json')
    const fg = await getForegroundWindowTitle()
    const windowTitle = fg ?? 'MapleStory'
    const countdown = Number(opts.countdown)
    if (Number.isFinite(countdown) && countdown > 0) {
      console.log(`focus the game window now — recording starts in ${countdown}s`)
      for (let i = countdown; i > 0; i--) {
        console.log(`  ${i}…`)
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    const recorder = new ReplayRecorder({
      map,
      windowTitle,
      outPath,
      // F10/F12 are bot-control hotkeys. Don't bake them into the recording.
      ignoreKeys: ['F10', 'F12'],
    })
    recorder.start()

    const { GlobalKeyboardListener } = await import('node-global-key-listener')
    const keyListener = new GlobalKeyboardListener()
    keyListener.addListener((e) => {
      const type = e.state === 'DOWN' ? 'keydown' : 'keyup'
      recorder.recordKey(type, String(e.name ?? ''))
    })

    console.log(`
recording... play normally. Press F12 to stop and save.
  out: ${outPath}
`)
    await new Promise<void>((resolve) => {
      const hk = new HotkeyService({
        onPauseToggle: () => {},
        onAbort: async () => {
          const r = recorder.stop()
          keyListener.kill()
          hk.stop()
          console.log(`
recorded:
  events:     ${r.events.length}
  durationMs: ${r.durationMs}
  out:        ${outPath}

next:
  hand-edit routines/${map}.yaml — set perception.detection_mode: replay
  and perception.recording_path: ${outPath}
  npm run dev -- run routines/${map}.yaml --mode live
`)
          resolve()
        },
      })
      hk.start()
    })
  })

program
  .command('label <map>')
  .description('Open a browser canvas to draw player/mob bounding boxes on captured frames. Saves YOLO-format labels next to each frame.')
  .option('--port <n>', 'fixed port (default: random)', '0')
  .option('--no-open', "don't auto-open the browser")
  .option('--model <path>', 'YOLO ONNX path for model-assisted suggestions (default: data/models/<map>.onnx)')
  .option('--no-model', 'disable model-assisted suggestions even when a model exists')
  .action(async (map, opts) => {
    const datasetDir = pathJoin('data', 'dataset', map)
    const rawDir = pathJoin(datasetDir, 'raw')
    if (!existsSync(rawDir)) {
      logger.error(
        { rawDir },
        `dataset not found — run \`capture ${map}\` first to collect frames`,
      )
      process.exit(1)
    }
    // Warn if the routine is in minimap-only mode — labels won't be used.
    const routinePath = pathJoin('routines', `${map}.yaml`)
    if (existsSync(routinePath)) {
      try {
        const r = Routine.parse(YAML.parse(readFileSync(routinePath, 'utf8')))
        if (r.perception.detection_mode === 'none') {
          logger.warn(
            { routinePath },
            'routine is in minimap-only mode (detection_mode=none) — labels here aren\'t used at runtime unless you switch back to detection_mode=yolo',
          )
        }
      } catch {
        // ignore parse errors here — labeler doesn't strictly need a routine
      }
    }
    const summary = readFrameList(map)
    const labeled = summary.filter((f) => f.labelCount > 0).length
    const unlabeled = summary.filter((f) => f.labelCount < 0).length
    logger.info({ frames: summary.length, labeled, unlabeled }, 'labeler: dataset loaded')

    const port = Number(opts.port) || 0
    const modelPath =
      opts.model === false
        ? undefined
        : (opts.model as string | undefined) ?? pathJoin('data', 'models', `${map}.onnx`)
    const modelAvailable = !!modelPath && existsSync(modelPath)
    if (modelPath && !modelAvailable) {
      logger.info({ modelPath }, 'labeler: no trained model yet — predict button will be disabled')
    }
    const server = await startLabelerServer({
      map,
      port,
      modelPath: modelAvailable ? modelPath : undefined,
    })

    const openUrl = (u: string) => {
      const cmd =
        process.platform === 'darwin'
          ? `open "${u}"`
          : process.platform === 'win32'
            ? `start "" "${u}"`
            : `xdg-open "${u}"`
      exec(cmd, (err) => {
        if (err) logger.warn({ err, url: u }, 'labeler: auto-open failed — open the URL manually')
      })
    }

    console.log(`
labeler running:
  ${server.url}/

  ${summary.length} frames in ${rawDir}/
  labeled    : ${labeled}
  unlabeled  : ${unlabeled}
  model      : ${modelAvailable ? modelPath : '(none — train one to enable model-assisted labeling)'}

Keyboard:
  drag        draw a box
  click box   select
  shift/space drag pan
  scroll      zoom
  + / -       zoom in / out
  0 / 1       fit / 100%
  1 / 2 …     set class for selected box (or default class for new boxes)
  s           save current frame
  e           save explicit empty (hard negative)
  d           delete current frame
  n           next unlabeled
  ← / →       prev / next frame
  p           predict (auto-fill suggestions from the trained model)

Workflow tip: label ~30-50 frames manually, then
  python python/train.py ${map} --quick
  python python/export_onnx.py ${map}
  npm run dev -- label ${map}      # reopen — predict button now active
…and use the predict button on each remaining frame instead of drawing
boxes from scratch. Cuts labeling time by ~3-5x.

Press Ctrl-C to stop the server.
`)
    if (opts.open !== false) openUrl(server.url)
    process.on('SIGINT', async () => {
      logger.info('labeler: SIGINT — stopping')
      await server.close()
      process.exit(0)
    })
  })

program
  .command('run <routinePath>')
  .option('--mode <mode>', 'dry-run|safe|live', 'dry-run')
  .option(
    '--no-detection',
    'force minimap-only mode (skip YOLO regardless of routine.perception.detection_mode)',
  )
  .action(async (routinePath, opts) => {
    if (!existsSync(routinePath)) {
      logger.error({ routinePath }, 'routine not found')
      process.exit(1)
    }
    const obj = YAML.parse(readFileSync(routinePath, 'utf8'))
    if (obj.unreviewed) {
      logger.error('routine marked unreviewed: true — review and remove flag first')
      process.exit(1)
    }
    let routine: Routine
    try {
      routine = Routine.parse(obj)
    } catch (err) {
      logger.error({ err }, 'routine schema validation failed')
      process.exit(1)
    }
    const bus = new TypedBus()
    const clock = new RealClock()
    const backend = new ForegroundNutBackend()
    const cap = new ScreenshotDesktopCapture()

    // v2 perception: load YOLO weights pointed at by routine.perception.model_path
    // (relative to cwd). Missing/broken file falls back to "stub mode" — runtime
    // emits empty detections per tick so movement + reflex still drive the bot.
    //
    // v2.2: detection_mode='none' (auto-maple style) skips YOLO entirely.
    // --no-detection CLI flag also forces this regardless of yaml setting.
    // detection_mode='replay' (record-and-play) loads a recording and ignores
    // YOLO entirely.
    const forceNoDetection = opts.detection === false
    const detectionMode =
      forceNoDetection ? 'none' : (routine.perception.detection_mode ?? 'yolo')
    let yolo: import('@/perception/yolo').YoloDetector | undefined
    let replayRecording: import('@/replay/format').Recording | undefined
    if (detectionMode === 'replay') {
      const recPath = routine.perception.recording_path
      if (!recPath || !existsSync(recPath)) {
        logger.error(
          { recording_path: recPath },
          'replay: recording_path missing or file not found — run `record-replay <map>` first',
        )
        process.exit(1)
      }
      const { loadRecording } = await import('@/replay/player')
      replayRecording = loadRecording(recPath)
      logger.info(
        { recPath, events: replayRecording.events.length, durationMs: replayRecording.durationMs },
        'replay: recording loaded',
      )
    } else if (detectionMode === 'none') {
      logger.info(
        { reason: forceNoDetection ? '--no-detection flag' : 'detection_mode=none' },
        'yolo: skipped — minimap-only mode (no mob detection)',
      )
    } else if (routine.perception.model_path && existsSync(routine.perception.model_path)) {
      const { YoloDetector } = await import('@/perception/yolo')
      yolo = new YoloDetector({
        modelPath: routine.perception.model_path,
        confidenceThreshold: routine.perception.confidence_threshold,
      })
      try {
        await yolo.load()
        logger.info({ modelPath: routine.perception.model_path }, 'yolo: ready')
      } catch (err) {
        logger.warn({ err, modelPath: routine.perception.model_path }, 'yolo: load failed — running in stub mode (no detections)')
        yolo = undefined
      }
    } else {
      logger.warn(
        { modelPath: routine.perception.model_path },
        'yolo: no model_path or file missing — running in stub mode (no detections)',
      )
    }
    const gameWindowFromYaml = (obj.game_window as Rect | undefined) ?? undefined

    const minimapColor = routine.minimap_player_color ?? {
      rgb: [240, 220, 60] as [number, number, number],
      tolerance: 30,
    }
    const minimap = new MinimapSampler({
      captureRegion: (r) => cap.captureRegion(r),
      region: routine.regions.minimap,
      matcher: minimapColor,
    })

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
      capture: cap,
      reflex,
      minimap,
      yolo,
      gameWindow: gameWindowFromYaml,
      replayRecording,
      bounds: routine.bounds
        ? {
            x: routine.bounds.x as [number, number],
            y: routine.bounds.y as [number, number],
          }
        : undefined,
      // Read margin from stop_condition.out_of_bounds.margin if present.
      // Default 30: the character's minimap dot moves vertically by roughly
      // its own height, so a 10-px margin is tight enough that a single
      // jump or platform shift trips out_of_bounds.
      boundsMargin: (() => {
        const oob = routine.stop_condition?.or.find(
          (c): c is { out_of_bounds: { margin: number } } =>
            typeof c === 'object' && c !== null && 'out_of_bounds' in c,
        )
        return oob?.out_of_bounds?.margin ?? 30
      })(),
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

    // 1 Hz state summary so users see life signs during a live run.
    let lastSummaryAt = 0
    const counts = { real: 0, dryRun: 0, safeBlocked: 0 }
    let lastPerceptionTick: { captureMs: number; detectMs: number; detections: number } | null =
      null
    bus.on('action.executed', (e) => {
      if (e.backend === 'dry-run') counts.dryRun++
      else if (e.backend === 'safe-blocked') counts.safeBlocked++
      else counts.real++
    })
    bus.on('perception.tick', (p) => {
      lastPerceptionTick = p
      // First tick: log immediately so user sees life signs before the 1 Hz
      // gate kicks in.
      if (lastSummaryAt === 0) {
        logger.info(
          { captureMs: p.captureMs, detectMs: p.detectMs, detections: p.detections },
          'perception: first tick complete',
        )
      }
    })
    bus.on('state.built', (s: GameState) => {
      const now = clock.now()
      if (now - lastSummaryAt < 1000) return
      lastSummaryAt = now
      logger.info(
        {
          mobs: s.combat.mobs.length,
          mobsLeft: s.combat.mobsLeft,
          mobsRight: s.combat.mobsRight,
          nearestMobDx: s.combat.nearestMobDx,
          playerScreenPos: s.combat.playerScreenPos,
          playerScreenSource: s.combat.playerScreenSource,
          minimapPos: s.nav.playerMinimapPos,
          boundsOk: s.nav.boundsOk,
          hp: Number(s.vitals.hp.toFixed(2)),
          mp: Number(s.vitals.mp.toFixed(2)),
          rune: s.flags.runeActive,
          actionsLast1s: { ...counts },
          perception: lastPerceptionTick,
        },
        'state',
      )
      counts.real = 0
      counts.dryRun = 0
      counts.safeBlocked = 0
    })

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const replayDir = pathJoin('recordings', 'runs', stamp)
    const replay = new ReplayWriter(replayDir)
    bus.on('state.built', (s) => replay.write('states', s))
    bus.on('action.executed', (e) => replay.write('actions', e))
    bus.on('action.error', (e) => replay.write('actions', e))
    bus.on('actuator.pause', (e) => replay.write('events', { kind: 'pause', ...e }))
    bus.on('actuator.resume', () => replay.write('events', { kind: 'resume' }))
    bus.on('actuator.abort', (e) => {
      replay.write('events', { kind: 'abort', ...e })
      // Internal aborts (out_of_bounds, repeated_failures) must STOP the run
      // loop. Otherwise we keep capturing + logging spam after the orchestrator
      // gave up.
      logger.info({ reason: e.reason }, 'orchestrator aborted — stopping run loop')
      stop = true
    })
    logger.info({ replayDir }, 'replay artifact dir')

    hk.start()
    logger.info({ mode: opts.mode }, 'running. F10 pause, F12 abort')
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
