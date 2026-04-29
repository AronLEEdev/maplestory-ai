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
import { TemplateLibrary } from '@/perception/template-library'
import type { Rect, Action, GameState } from '@/core/types'
import { defaultRegions } from '@/core/maplestory-defaults'
import { ReplayWriter } from '@/replay/writer'
import { join as pathJoin } from 'node:path'
import { importFromRawDir } from '@/perception/sprite-import'
import { mkdirSync, writeFileSync } from 'node:fs'
import { startCalibrateServer } from '@/calibrate/server'
import { exec } from 'node:child_process'

const MAPLESTORY_IO_HELP = `
For each mob on your map:
  1. Visit  https://maplestory.io/api/<region>/<ver>/mob   (region e.g. GMS, MSEA, KMS)
  2. Search by name or browse by ID.
  3. Download these animation frames if available:
       stand (or idle)  — most important; used as default template
       move             — recommended
       attack           — optional
  4. Save to: data/sprites-raw/<map>/<mob_class>/<animation>.png
  5. (Optional) drop a player snapshot to data/sprites-raw/<map>/_player/stand.png
     for tighter combat distance. Without it the bot uses screen center.

Region tip: GMS sprites usually work for any region — visual templates match
even when mob IDs differ.
`.trim()

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

    // 3. Copy each template + its dims into the inspect dir.
    if (existsSync(routine.perception.template_dir)) {
      const lib = await TemplateLibrary.load(routine.perception.template_dir)
      const dims = lib.dims()
      logger.info({ templates: dims }, 'templates loaded')
      const tDir = routine.perception.template_dir
      const files = (await fs.readdir(tDir)).filter((f) => f.endsWith('.png'))
      for (const f of files) {
        await fs.copyFile(pathJoin(tDir, f), pathJoin(opts.out, `template-${f}`))
      }
    }

    // 4. Annotated full-frame: overlay rectangles using sharp.composite with
    //    a tiny red 1px border SVG per region.
    try {
      const svgRects = (Object.entries(routine.regions) as [string, Rect][])
        .filter(([, r]) => r != null)
        .map(([name, r]) => {
          return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" stroke="red" stroke-width="3" fill="none"/><text x="${r.x + 4}" y="${r.y - 4}" font-size="20" fill="red" font-family="sans-serif">${name}</text>`
        })
        .join('\n')

      // Combat anchor + mobs_in_range visualization. The anchor is where the
      // bot measures mob distance from when no `player` template detects.
      // Show the point and the horizontal band any rotation rule of the form
      // `mobs_in_range(N)` covers.
      const anchorX = W / 2 + (routine.perception.combat_anchor?.x_offset_from_center ?? 0)
      const anchorY = H / 2 + (routine.perception.combat_anchor?.y_offset_from_center ?? 0)
      const ranges: number[] = []
      for (const rule of routine.rotation) {
        if (!('when' in rule)) continue
        const m = /mobs_in_range\(\s*(\d+)\s*\)/.exec(rule.when)
        if (m) ranges.push(Number(m[1]))
      }
      const rangeSvg = ranges
        .map(
          (px) =>
            `<rect x="${anchorX - px}" y="${anchorY - 30}" width="${px * 2}" height="60" stroke="#0ff" stroke-width="2" fill="rgba(0,200,255,0.10)"/>` +
            `<text x="${anchorX - px + 4}" y="${anchorY - 36}" font-size="16" fill="#0ff" font-family="sans-serif">mobs_in_range(${px})</text>`,
        )
        .join('\n')
      const anchorSvg = `
        <line x1="${anchorX - 18}" y1="${anchorY}" x2="${anchorX + 18}" y2="${anchorY}" stroke="lime" stroke-width="3"/>
        <line x1="${anchorX}" y1="${anchorY - 18}" x2="${anchorX}" y2="${anchorY + 18}" stroke="lime" stroke-width="3"/>
        <circle cx="${anchorX}" cy="${anchorY}" r="6" stroke="lime" stroke-width="3" fill="none"/>
        <text x="${anchorX + 12}" y="${anchorY - 12}" font-size="18" fill="lime" font-family="sans-serif">combat anchor</text>
      `

      const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svgRects}${rangeSvg}${anchorSvg}</svg>`
      await sharp(png)
        .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
        .toFile(pathJoin(opts.out, 'full-annotated.png'))
      logger.info('wrote full-annotated.png — open it to verify region rectangles')
    } catch (err) {
      logger.warn({ err }, 'annotated overlay failed')
    }

    console.log(`
inspect output → ${opts.out}/

Open in Finder / Preview:
  - full.png            full screen capture (look at this first — does it show the GAME?)
  - full-annotated.png  same image with routine.regions overlayed in red rectangles
  - region-hp.png       cropped HP bar (should look like a red bar)
  - region-mp.png       cropped MP bar (should look like a blue bar)
  - region-minimap.png  cropped minimap (should look like the minimap)

  In full-annotated.png also check:
  - lime crosshair    = combat anchor (where the bot measures mob distance from)
                        should sit ON or very near your character
  - cyan band         = mobs_in_range(N) rectangle (one per rotation rule)
                        should reach the mobs you intend to attack
  - red rectangles    = HP / MP / minimap regions; should hug each UI element
  - template-*.png      every template the runtime will match against

If full.png doesn't show the game → capture is wrong (Mac Spaces issue or display perm)
If region-hp.png is empty or shows wrong content → routine.regions.hp coords are wrong
If templates look way smaller/larger than mobs in full.png → multi-scale mismatch
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
          console.log(`
Calibration complete:
  routine:   ${result.routinePath}
  templates: ${result.templatesDir}  (${result.templatesWritten} variants)
${result.warnings.length ? '\nwarnings:\n  - ' + result.warnings.join('\n  - ') + '\n' : ''}
Next:
  npm run dev -- inspect ${result.routinePath}
  npm run dev -- run ${result.routinePath} --mode dry-run
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

program
  .command('import-sprites <map>')
  .description('Import manually-downloaded sprites from data/sprites-raw/<map>/ into data/templates/<map>/')
  .option('--from <dir>', 'override raw dir (default: data/sprites-raw/<map>)')
  .option('--templates <dir>', 'override templates dir (default: data/templates/<map>)')
  .addHelpText('after', `\nWhere to get sprites:\n${MAPLESTORY_IO_HELP}\n`)
  .action(async (map, opts) => {
    const rawDir = opts.from ?? pathJoin('data', 'sprites-raw', map)
    const templatesDir = opts.templates ?? pathJoin('data', 'templates', map)
    if (!existsSync(rawDir)) {
      logger.error({ rawDir }, 'raw dir not found — drop sprite PNGs there first')
      console.log(`\nWhere to get sprites:\n${MAPLESTORY_IO_HELP}\n`)
      process.exit(1)
    }
    try {
      const r = await importFromRawDir({ rawDir, templatesDir })
      logger.info(
        { mobs: r.mobs, variants: r.variants, manifestPath: r.manifestPath },
        'import-sprites: done',
      )
      console.log(`
Templates ready at ${templatesDir}/
Imported ${r.mobs} mob class(es), ${r.variants} variant(s).

In your routine YAML set:
  perception:
    template_dir: ${templatesDir}
    fps: 12
    match_threshold: 0.75
`)
    } catch (err) {
      logger.error({ err }, 'import-sprites: failed')
      process.exit(1)
    }
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
  .command('run <routinePath>')
  .option('--mode <mode>', 'dry-run|safe|live', 'dry-run')
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

    if (!existsSync(routine.perception.template_dir)) {
      logger.error(
        { template_dir: routine.perception.template_dir },
        'template_dir not found — run `import-sprites <map>` first',
      )
      process.exit(1)
    }
    const templateLibrary = await TemplateLibrary.load(routine.perception.template_dir)
    const templateThreshold = routine.perception.match_threshold
    const templateStride = routine.perception.stride
    const templateSearchRegion = routine.perception.search_region
    const templateMaxPerClass = routine.perception.max_per_class
    logger.info(
      {
        template_dir: routine.perception.template_dir,
        templates: templateLibrary.size(),
        classes: templateLibrary.classes(),
      },
      'template library loaded',
    )

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
      templateLibrary,
      templateThreshold,
      templateStride,
      templateMaxPerClass,
      templateSearchRegion,
      combatAnchor: routine.perception.combat_anchor,
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
          mobs: s.enemies.length,
          mobsInRange300: s.enemies.filter((e) => e.distancePx <= 300).length,
          playerPos: s.player.pos,
          playerPosSource: s.player.posSource,
          hp: Number(s.player.hp.toFixed(2)),
          mp: Number(s.player.mp.toFixed(2)),
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
