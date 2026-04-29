import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import sharp from 'sharp'
import { logger } from '@/core/logger'

/**
 * Reserved underscore-prefixed folder names that map to canonical class names
 * understood by the runtime (no `mob_` prefix).
 *
 * Currently only `_player` is consumed (provides a screen-space combat anchor
 * via the two-tier resolution in state-builder). `_rune` is reserved for v1.3.
 */
const RESERVED_FOLDERS: Record<string, string> = {
  _player: 'player',
  _rune: 'rune',
}

/**
 * Variant filename normalization. Maplestory animation names vary by sprite
 * source; collapse synonyms so the runtime sees a stable label.
 */
const VARIANT_ALIASES: Record<string, string> = {
  stand: 'idle',
  idle: 'idle',
  move: 'move',
  walk: 'move',
  jump: 'move',
  attack: 'attack',
  attack1: 'attack',
  hit: 'hit',
  die: 'die',
}

export interface ImportOpts {
  rawDir: string // e.g. data/sprites-raw/<map>
  templatesDir: string // e.g. data/templates/<map>
}

export interface ImportSummary {
  mobs: number
  variants: number
  warnings: string[]
  manifestPath: string
}

interface ManifestEntryOut {
  file: string
  class: string
  variant?: string
  source_frame?: string
  bbox_in_source?: [number, number, number, number]
}

/**
 * Read every `<rawDir>/<class-folder>/<variant>.png`, validate, and write the
 * canonical template manifest + PNG copies into `templatesDir`.
 *
 * Folder naming:
 *   - `_player`, `_rune`, ... → reserved canonical class names
 *   - any other folder → auto-prefixed with `mob_` (`green_snail` → `mob_green_snail`)
 *   - any other underscore-prefixed folder is REJECTED with a clear error.
 */
export async function importFromRawDir(opts: ImportOpts): Promise<ImportSummary> {
  const warnings: string[] = []
  if (!safeIsDir(opts.rawDir)) {
    throw new Error(`import-sprites: raw dir not found: ${opts.rawDir}`)
  }
  mkdirSync(opts.templatesDir, { recursive: true })

  const entries = readdirSync(opts.rawDir, { withFileTypes: true })
  const mobFolders = entries.filter((e) => e.isDirectory())
  if (mobFolders.length === 0) {
    throw new Error(
      `import-sprites: no subfolders in ${opts.rawDir}. Expect <map>/<mob>/*.png.`,
    )
  }

  const manifestEntries: ManifestEntryOut[] = []
  let mobCount = 0
  let variantCount = 0

  for (const folder of mobFolders) {
    const folderName = folder.name
    const className = resolveClassName(folderName)
    if (className === null) {
      throw new Error(
        `import-sprites: folder "${folderName}" starts with "_" but is not a known reserved name. Allowed: ${Object.keys(RESERVED_FOLDERS).join(', ')}.`,
      )
    }
    const folderPath = join(opts.rawDir, folderName)
    const pngs = readdirSync(folderPath).filter((f) => f.toLowerCase().endsWith('.png'))
    if (pngs.length === 0) {
      warnings.push(`folder "${folderName}" has no .png files — skipped`)
      continue
    }
    let variantsForThisMob = 0
    for (const png of pngs) {
      const srcPath = join(folderPath, png)
      const variant = normalizeVariant(basename(png, extname(png)))
      try {
        const meta = await sharp(srcPath).metadata()
        if (!meta.width || !meta.height) {
          warnings.push(`${folderName}/${png}: unreadable dimensions — skipped`)
          continue
        }
        if (meta.width < 8 || meta.height < 8) {
          warnings.push(
            `${folderName}/${png}: too small (${meta.width}x${meta.height}) — skipped`,
          )
          continue
        }
        // Ensure non-transparent: at least one fully-opaque pixel exists. If
        // a sprite is sourced from a site that ships alpha cutouts, it's still
        // fine (ZNCC ignores alpha after removeAlpha).
        const stats = await sharp(srcPath).stats()
        const alphaChannel = stats.channels[3]
        if (alphaChannel && alphaChannel.max === 0) {
          warnings.push(`${folderName}/${png}: fully transparent — skipped`)
          continue
        }
        const outFile = `${className}-${variant}.png`
        await sharp(srcPath).toFile(join(opts.templatesDir, outFile))
        manifestEntries.push({
          file: outFile,
          class: className,
          variant,
          source_frame: `${folderName}/${png}`,
        })
        variantsForThisMob++
        variantCount++
      } catch (err) {
        warnings.push(
          `${folderName}/${png}: ${err instanceof Error ? err.message : String(err)} — skipped`,
        )
      }
    }
    if (variantsForThisMob > 0) mobCount++
  }

  if (manifestEntries.length === 0) {
    throw new Error(
      `import-sprites: no usable PNGs found under ${opts.rawDir}. See warnings above.`,
    )
  }
  const manifestPath = join(opts.templatesDir, 'manifest.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({ templates: manifestEntries }, null, 2),
  )
  for (const w of warnings) logger.warn({ rawDir: opts.rawDir }, `import: ${w}`)
  return { mobs: mobCount, variants: variantCount, warnings, manifestPath }
}

function resolveClassName(folderName: string): string | null {
  if (folderName.startsWith('_')) {
    return RESERVED_FOLDERS[folderName] ?? null
  }
  return `mob_${folderName}`
}

function normalizeVariant(stem: string): string {
  const key = stem.toLowerCase().replace(/[^a-z0-9_]/g, '')
  return VARIANT_ALIASES[key] ?? key
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
