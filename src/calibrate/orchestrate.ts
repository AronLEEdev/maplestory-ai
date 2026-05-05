import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import YAML from 'yaml'
import { logger } from '@/core/logger'
import type { Rect } from '@/core/types'
import { writeRoutine, type CalibrationData } from './yaml-writer'

/**
 * The shape the browser POSTs to /save. All rectangles are in
 * full-display-pixel space EXCEPT where noted.
 */
export interface SaveBody {
  windowTitle: string
  gameWindow?: Rect
  regions: { hp: Rect; mp: Rect; minimap: Rect }
  /** Pixel coord (display-space) where user clicked to sample player dot.
   *  Optional in replay mode (where minimap pos isn't used at runtime). */
  playerDotAt?: { x: number; y: number }
  /** Two corner pixel coords inside the minimap region (minimap-LOCAL).
   *  Optional in replay mode. */
  bounds?: { topLeft: { x: number; y: number }; bottomRight: { x: number; y: number } }
  /** Each entry is a minimap-LOCAL x coord. */
  waypointXs: number[]
  /** Each entry: bbox in display-space + a sprite name. `rect` may be null
   *  for entries derived from an older calibration where only the cropped
   *  PNG survives — orchestrate skips re-extraction for those and trusts
   *  the existing sprites-raw file on disk. */
  mobCrops: Array<{ name: string; rect: Rect | null }>
  /** Optional player crop in display-space. Same null semantics as mobCrops. */
  playerCrop?: Rect | null
  /** v2.2: 'yolo' (default) trains + uses YOLO. 'none' is auto-maple style
   *  (minimap + cadence attack, no ML). 'replay' is record-and-play
   *  (no detection, blind playback of a recording.json). */
  detectionMode?: 'yolo' | 'none' | 'replay'
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
  /** v2.2: surfaces the detection mode chosen so CLI can branch its
   *  next-steps message (YOLO needs capture+label+train; none doesn't;
   *  replay needs record-replay). */
  detectionMode: 'yolo' | 'none' | 'replay'
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


  // Replay mode: dot/bounds optional. Default to a fallback yellow color +
  // minimap-region-sized bounds so the schema validates and the runtime can
  // still log minimap pos for debugging (no out_of_bounds in replay).
  const isReplay = opts.body.detectionMode === 'replay'
  const dotAt = opts.body.playerDotAt
  const boundsIn = opts.body.bounds
  const hasDot = !!dotAt
  const hasBounds = !!boundsIn?.topLeft && !!boundsIn?.bottomRight

  const dotRgb: [number, number, number] = dotAt
    ? await sampleColor(opts.screenshotPng, dotAt)
    : [240, 220, 60] // typical Maplestory player-dot yellow
  if (!hasDot && !isReplay) {
    throw new Error('orchestrateSave: playerDotAt required outside replay mode')
  }

  // Map minimap-local bounds back to a clean tuple shape. Users on flat-
  // ground maps tend to click both corners on the same horizontal line,
  // collapsing the y range to ~1 px. Character minimap-y still varies by
  // tens of pixels (jumps, slight platform offsets), so a degenerate range
  // immediately trips out_of_bounds. Inflate to a minimum spread.
  const MIN_BOUND_SPREAD = 30
  let bx: [number, number]
  let by: [number, number]
  if (boundsIn?.topLeft && boundsIn?.bottomRight) {
    bx = [
      Math.min(boundsIn.topLeft.x, boundsIn.bottomRight.x),
      Math.max(boundsIn.topLeft.x, boundsIn.bottomRight.x),
    ]
    by = [
      Math.min(boundsIn.topLeft.y, boundsIn.bottomRight.y),
      Math.max(boundsIn.topLeft.y, boundsIn.bottomRight.y),
    ]
    if (bx[1] - bx[0] < MIN_BOUND_SPREAD) {
      const c = (bx[0] + bx[1]) / 2
      bx = [Math.round(c - MIN_BOUND_SPREAD / 2), Math.round(c + MIN_BOUND_SPREAD / 2)]
    }
    if (by[1] - by[0] < MIN_BOUND_SPREAD) {
      const c = (by[0] + by[1]) / 2
      by = [Math.round(c - MIN_BOUND_SPREAD / 2), Math.round(c + MIN_BOUND_SPREAD / 2)]
    }
  } else if (isReplay) {
    // Replay mode bounds unused at runtime; fill with the minimap region's
    // own dims so the schema validates.
    const mm = opts.body.regions.minimap
    bx = [0, mm.w]
    by = [0, mm.h]
  } else {
    throw new Error('orchestrateSave: bounds required outside replay mode')
  }
  void hasDot
  void hasBounds

  // v2.0: no sprite extraction. The dataset (frame captures + labels) lives
  // under data/dataset/<map>/ and is collected by the `capture` command +
  // canvas labeler, then fed to the YOLO training script. The routine YAML
  // points at the trained model path (data/models/<map>.onnx).
  const warnings: string[] = []
  void templatesDir
  void spritesRawDir

  // Compose + write the routine YAML. modelPath points at the per-map ONNX
  // weights produced by `python/export_onnx.py`. The runtime treats a missing
  // file as "stub mode" — no detections, but everything else (minimap,
  // movement, reflex) still works.
  const modelPath = join('data', 'models', `${map}.onnx`)
  const recordingPath = join('replays', map, 'recording.json')
  const calibrationData: CalibrationData = {
    resolution: [screenW, screenH],
    windowTitle: opts.body.windowTitle,
    gameWindow: opts.body.gameWindow,
    regions: opts.body.regions,
    minimapPlayerColor: { rgb: dotRgb, tolerance: 12 },
    bounds: { x: bx, y: by },
    waypointXs: opts.body.waypointXs,
    modelPath,
    recordingPath,
    detectionMode: opts.body.detectionMode ?? 'yolo',
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

  logger.info({ routinePath, modelPath }, 'calibrate: save complete')

  return {
    routinePath,
    templatesDir,
    manifestPath: '',
    templatesWritten: 0,
    warnings,
    detectionMode: (opts.body.detectionMode ?? 'yolo') as 'yolo' | 'none' | 'replay',
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
