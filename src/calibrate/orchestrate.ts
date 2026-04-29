import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { logger } from '@/core/logger'
import type { Rect } from '@/core/types'
import { importFromRawDir } from '@/perception/sprite-import'
import { writeRoutine, type CalibrationData } from './yaml-writer'

/**
 * The shape the browser POSTs to /save. All rectangles are in
 * full-display-pixel space EXCEPT where noted.
 */
export interface SaveBody {
  windowTitle: string
  gameWindow?: Rect
  regions: { hp: Rect; mp: Rect; minimap: Rect }
  /** Pixel coord (display-space) where user clicked to sample player dot. */
  playerDotAt: { x: number; y: number }
  /** Two corner pixel coords inside the minimap region (minimap-LOCAL). */
  bounds: { topLeft: { x: number; y: number }; bottomRight: { x: number; y: number } }
  /** Each entry is a minimap-LOCAL x coord. */
  waypointXs: number[]
  /** Each entry: bbox in display-space + a sprite name. */
  mobCrops: Array<{ name: string; rect: Rect }>
  /** Optional player crop in display-space. */
  playerCrop?: Rect
}

export interface OrchestrateOpts {
  map: string
  /** PNG buffer of the captured screen, kept in memory by the server. */
  screenshotPng: Buffer
  body: SaveBody
  /** Where to write the routine. Default: `routines/<map>.yaml`. */
  routinesDir?: string
  /** Where sprite raw drops go. Default: `data/sprites-raw/<map>`. */
  spritesRawDir?: string
  /** Where templates land. Default: `data/templates/<map>`. */
  templatesDir?: string
  /** Haystack downscale factor at runtime — pre-resize templates to match. */
  runtimeDownscale?: number
}

export interface OrchestrateResult {
  routinePath: string
  templatesDir: string
  manifestPath: string
  templatesWritten: number
  warnings: string[]
}

/**
 * Take everything the calibration UI submitted, write the sprite PNGs,
 * generate the template manifest, and compose the routine YAML.
 *
 * The runtime perception path downscales the haystack to longest-edge 1000
 * (see `MAX_HAYSTACK_LONG_EDGE` in orchestrator.ts). Templates must arrive
 * pre-downscaled by the same factor to match in ZNCC. We compute the factor
 * from the captured screen dims and apply it on every sprite save.
 */
export async function orchestrateSave(
  opts: OrchestrateOpts,
): Promise<OrchestrateResult> {
  const map = opts.map
  const routinesDir = opts.routinesDir ?? 'routines'
  const spritesRawDir = opts.spritesRawDir ?? join('data', 'sprites-raw', map)
  const templatesDir = opts.templatesDir ?? join('data', 'templates', map)
  const routinePath = join(routinesDir, `${map}.yaml`)

  const meta = await sharp(opts.screenshotPng).metadata()
  const screenW = meta.width ?? 0
  const screenH = meta.height ?? 0
  if (!screenW || !screenH) {
    throw new Error('orchestrateSave: screenshot has no dimensions')
  }

  // Runtime haystack scale factor — must match orchestrator.ts MAX_HAYSTACK_LONG_EDGE.
  const longEdge = Math.max(screenW, screenH)
  const runtimeScale =
    opts.runtimeDownscale ?? (longEdge > 1000 ? longEdge / 1000 : 1)

  // Sample player-dot RGB from the captured PNG at the user's click coord.
  const dotRgb = await sampleColor(opts.screenshotPng, opts.body.playerDotAt)

  // Map minimap-local bounds back to a clean tuple shape.
  const bx: [number, number] = [
    Math.min(opts.body.bounds.topLeft.x, opts.body.bounds.bottomRight.x),
    Math.max(opts.body.bounds.topLeft.x, opts.body.bounds.bottomRight.x),
  ]
  const by: [number, number] = [
    Math.min(opts.body.bounds.topLeft.y, opts.body.bounds.bottomRight.y),
    Math.max(opts.body.bounds.topLeft.y, opts.body.bounds.bottomRight.y),
  ]

  // Clean any prior scaffold so a recalibration produces a clean library.
  // (The runtime templates dir gets fully rebuilt by importFromRawDir below.)
  if (existsSync(templatesDir)) {
    rmSync(templatesDir, { recursive: true, force: true })
  }
  mkdirSync(spritesRawDir, { recursive: true })

  // Save mob sprite crops, pre-downscaled to runtime haystack scale.
  const usedNames = new Set<string>()
  for (const crop of opts.body.mobCrops) {
    let name = sanitizeName(crop.name) || `mob${usedNames.size + 1}`
    while (usedNames.has(name)) name = `${name}_${usedNames.size + 1}`
    usedNames.add(name)
    const dir = join(spritesRawDir, name)
    mkdirSync(dir, { recursive: true })
    await extractAndSave(opts.screenshotPng, crop.rect, runtimeScale, join(dir, 'stand.png'))
  }

  // Optional player crop.
  if (opts.body.playerCrop) {
    const dir = join(spritesRawDir, '_player')
    mkdirSync(dir, { recursive: true })
    await extractAndSave(
      opts.screenshotPng,
      opts.body.playerCrop,
      runtimeScale,
      join(dir, 'stand.png'),
    )
  }

  // Generate the runtime template library.
  const importSummary = await importFromRawDir({ rawDir: spritesRawDir, templatesDir })

  // Pin the combat anchor (used for mobs_in_range when the player template
  // doesn't detect at runtime) to the game-window center. Without this, the
  // anchor falls back to display center; for users whose game window is
  // offset within the display, the anchor lands far from the character and
  // mobs_in_range silently filters everything out.
  // Preference: gameWindow center (stable across the run) > playerCrop
  // center (calibration-time only) > nothing.
  let combatAnchor: { x_offset_from_center: number; y_offset_from_center: number } | undefined
  if (opts.body.gameWindow) {
    const gw = opts.body.gameWindow
    combatAnchor = {
      x_offset_from_center: Math.round(gw.x + gw.w / 2 - screenW / 2),
      y_offset_from_center: Math.round(gw.y + gw.h / 2 - screenH / 2),
    }
  } else if (opts.body.playerCrop) {
    const pc = opts.body.playerCrop
    combatAnchor = {
      x_offset_from_center: Math.round(pc.x + pc.w / 2 - screenW / 2),
      y_offset_from_center: Math.round(pc.y + pc.h / 2 - screenH / 2),
    }
  }

  // Compose + write the routine YAML.
  const calibrationData: CalibrationData = {
    resolution: [screenW, screenH],
    windowTitle: opts.body.windowTitle,
    gameWindow: opts.body.gameWindow,
    regions: opts.body.regions,
    minimapPlayerColor: { rgb: dotRgb, tolerance: 12 },
    bounds: { x: bx, y: by },
    waypointXs: opts.body.waypointXs,
    templateDir: templatesDir,
    combatAnchor,
  }
  writeRoutine({ routinePath, data: calibrationData })

  logger.info(
    {
      routinePath,
      templatesDir,
      runtimeScale,
      mobs: importSummary.mobs,
      variants: importSummary.variants,
    },
    'calibrate: save complete',
  )

  return {
    routinePath,
    templatesDir,
    manifestPath: importSummary.manifestPath,
    templatesWritten: importSummary.variants,
    warnings: importSummary.warnings,
  }
}

/**
 * Read a single pixel's RGB from a PNG buffer at the given display-space coord.
 */
export async function sampleColor(
  png: Buffer,
  at: { x: number; y: number },
): Promise<[number, number, number]> {
  const meta = await sharp(png).metadata()
  if (!meta.width || !meta.height) throw new Error('sampleColor: bad PNG')
  const x = Math.max(0, Math.min(meta.width - 1, Math.round(at.x)))
  const y = Math.max(0, Math.min(meta.height - 1, Math.round(at.y)))
  // Extract a 1×1 region as raw RGB.
  const buf = await sharp(png)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer()
  return [buf[0], buf[1], buf[2]]
}

/**
 * Crop a rect from the source PNG, downscale by the runtime factor, save as
 * PNG. Pre-downscaling here keeps the runtime template-match scale aligned
 * with the haystack downscale in orchestrator.ts.
 */
async function extractAndSave(
  png: Buffer,
  rect: Rect,
  scale: number,
  outPath: string,
): Promise<void> {
  let pipeline = sharp(png).extract({
    left: Math.max(0, Math.round(rect.x)),
    top: Math.max(0, Math.round(rect.y)),
    width: Math.max(1, Math.round(rect.w)),
    height: Math.max(1, Math.round(rect.h)),
  })
  if (scale > 1) {
    const newW = Math.max(1, Math.round(rect.w / scale))
    const newH = Math.max(1, Math.round(rect.h / scale))
    pipeline = pipeline.resize({ width: newW, height: newH, fit: 'fill' })
  }
  await pipeline.png().toFile(outPath)
}

function sanitizeName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
}
