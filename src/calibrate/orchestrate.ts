import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import YAML from 'yaml'
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
  /** Each entry: bbox in display-space + a sprite name. `rect` may be null
   *  for entries derived from an older calibration where only the cropped
   *  PNG survives — orchestrate skips re-extraction for those and trusts
   *  the existing sprites-raw file on disk. */
  mobCrops: Array<{ name: string; rect: Rect | null }>
  /** Optional player crop in display-space. Same null semantics as mobCrops. */
  playerCrop?: Rect | null
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
  // Entries with rect=null come from a re-hydrated old calibration where the
  // PNG already exists on disk; skip extraction and trust the existing file.
  const usedNames = new Set<string>()
  for (const crop of opts.body.mobCrops) {
    let name = sanitizeName(crop.name) || `mob${usedNames.size + 1}`
    while (usedNames.has(name)) name = `${name}_${usedNames.size + 1}`
    usedNames.add(name)
    if (!crop.rect) continue
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

  // Combat anchor (used for mobs_in_range when the player template doesn't
  // detect at runtime).
  //   X: gameWindow center — stable across the run, camera follows the
  //      character horizontally so this tracks them well.
  //   Y: playerCrop center if available — character is on a platform near
  //      the bottom of the game window, NOT at vertical center (which lands
  //      in the sky). Falls back to gameWindow center y if no playerCrop.
  // y_band defaults to 80 px when we have playerCrop so mobs on other
  // platforms (different y) don't count toward in-range checks.
  let combatAnchor:
    | {
        x_offset_from_center: number
        y_offset_from_center: number
        y_band?: number
      }
    | undefined
  const gw = opts.body.gameWindow
  const pc = opts.body.playerCrop
  if (gw || pc) {
    const ax = gw ? gw.x + gw.w / 2 : pc!.x + pc!.w / 2
    const ay = pc ? pc.y + pc.h / 2 : gw!.y + gw!.h / 2
    combatAnchor = {
      x_offset_from_center: Math.round(ax - screenW / 2),
      y_offset_from_center: Math.round(ay - screenH / 2),
    }
    if (pc) combatAnchor.y_band = 80
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

  // Sidecar JSON: full SaveBody + capture resolution. Lets a future
  // `calibrate <map>` re-hydrate the wizard so the user can edit one step
  // instead of redoing everything.
  const sidecarPath = sidecarPathFor(routinesDir, map)
  mkdirSync(join(routinesDir, '.calibrate'), { recursive: true })
  writeFileSync(
    sidecarPath,
    JSON.stringify({ resolution: [screenW, screenH], body: opts.body }, null, 2),
  )

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

/** Sidecar path holding the full SaveBody from the last calibration of this map. */
export function sidecarPathFor(routinesDir: string, map: string): string {
  return join(routinesDir, '.calibrate', `${map}.json`)
}

/**
 * Read the saved SaveBody for a previously-calibrated map. Tries the
 * authoritative sidecar JSON first; if missing (older calibrations
 * predate the sidecar), falls back to deriving as much as possible from
 * the routine YAML + listing existing sprites-raw dirs. The fallback
 * carries `rect: null` for sprite entries since the original crop coords
 * weren't preserved in the YAML.
 */
export function loadExistingCalibration(
  routinesDir: string,
  map: string,
  spritesRawDir?: string,
): { resolution: [number, number]; body: SaveBody } | null {
  const sidecar = sidecarPathFor(routinesDir, map)
  if (existsSync(sidecar)) {
    try {
      return JSON.parse(readFileSync(sidecar, 'utf8'))
    } catch (err) {
      logger.warn({ err, sidecar }, 'calibrate: sidecar parse failed — falling through')
    }
  }
  // Fallback: synthesize SaveBody from the YAML.
  const yamlPath = join(routinesDir, `${map}.yaml`)
  if (!existsSync(yamlPath)) return null
  let yaml: Record<string, unknown>
  try {
    yaml = YAML.parse(readFileSync(yamlPath, 'utf8'))
  } catch (err) {
    logger.warn({ err, yamlPath }, 'calibrate: yaml parse failed — no rehydrate')
    return null
  }
  const regions = yaml.regions as { hp?: Rect; mp?: Rect; minimap?: Rect } | undefined
  if (!regions?.hp || !regions?.mp || !regions?.minimap) return null
  const resolution = (yaml.resolution as [number, number]) ?? [0, 0]
  const boundsYaml = yaml.bounds as { x?: [number, number]; y?: [number, number] } | undefined
  const bounds =
    boundsYaml?.x && boundsYaml?.y
      ? {
          topLeft: { x: boundsYaml.x[0], y: boundsYaml.y[0] },
          bottomRight: { x: boundsYaml.x[1], y: boundsYaml.y[1] },
        }
      : { topLeft: { x: 0, y: 0 }, bottomRight: { x: 0, y: 0 } }
  const movement = yaml.movement as { primitives?: Array<Record<string, unknown>> } | undefined
  const waypointXs =
    movement?.primitives
      ?.filter((p) => p.op === 'walk_to_x')
      .map((p) => Number(p.x))
      .filter((n) => Number.isFinite(n)) ?? []

  // List existing sprite dirs so the user can save without re-cropping.
  // Entries get rect=null — orchestrate then skips re-extraction and the
  // existing PNG on disk flows through importFromRawDir untouched.
  const rawDir = spritesRawDir ?? join('data', 'sprites-raw', map)
  const mobCrops: Array<{ name: string; rect: Rect | null }> = []
  let playerCropPresent = false
  if (existsSync(rawDir)) {
    for (const entry of readdirSync(rawDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name === '_player') playerCropPresent = true
      else mobCrops.push({ name: entry.name, rect: null })
    }
  }

  const body: SaveBody = {
    windowTitle: (yaml.window_title as string) ?? 'MapleStory',
    gameWindow: yaml.game_window as Rect | undefined,
    regions: { hp: regions.hp, mp: regions.mp, minimap: regions.minimap },
    // playerDotAt is only stored as resulting RGB in the yaml; surface a
    // synthetic coord at minimap center so re-hydration reports SOMETHING
    // (user can re-click in Step 5 if they want a fresh sample).
    playerDotAt: {
      x: Math.round(regions.minimap.x + regions.minimap.w / 2),
      y: Math.round(regions.minimap.y + regions.minimap.h / 2),
    },
    bounds,
    waypointXs,
    mobCrops,
    // null marks "present on disk, no rect" so canSave counts it without
    // re-extraction. undefined means the user never cropped a player.
    playerCrop: playerCropPresent ? null : undefined,
  }
  return { resolution, body }
}

function sanitizeName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
}
