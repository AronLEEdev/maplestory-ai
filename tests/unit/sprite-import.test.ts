import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { importFromRawDir } from '@/perception/sprite-import'

let root: string
let raw: string
let templates: string

async function pngAt(path: string, w: number, h: number, color: [number, number, number]) {
  const buf = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    buf[i * 3] = color[0]
    buf[i * 3 + 1] = color[1]
    buf[i * 3 + 2] = color[2]
  }
  // Add a 4x4 contrasting block to keep ZNCC happy if the importer ever
  // re-validates content; not strictly required here.
  for (let y = 0; y < Math.min(4, h); y++) {
    for (let x = 0; x < Math.min(4, w); x++) {
      const i = (y * w + x) * 3
      buf[i] = 0
      buf[i + 1] = 0
      buf[i + 2] = 0
    }
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(path)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sprimp-'))
  raw = join(root, 'raw')
  templates = join(root, 'templates')
  mkdirSync(raw, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('importFromRawDir', () => {
  it('auto-prefixes mob_ for normal folders', async () => {
    mkdirSync(join(raw, 'green_snail'))
    await pngAt(join(raw, 'green_snail', 'stand.png'), 32, 32, [0, 200, 0])
    await pngAt(join(raw, 'green_snail', 'move.png'), 32, 32, [0, 180, 0])

    const r = await importFromRawDir({ rawDir: raw, templatesDir: templates })
    expect(r.mobs).toBe(1)
    expect(r.variants).toBe(2)
    const m = JSON.parse(readFileSync(r.manifestPath, 'utf8'))
    const classes = m.templates.map((t: { class: string }) => t.class)
    expect(classes.every((c: string) => c === 'mob_green_snail')).toBe(true)
  })

  it('normalizes stand→idle, walk→move variants', async () => {
    mkdirSync(join(raw, 'orange_mushroom'))
    await pngAt(join(raw, 'orange_mushroom', 'stand.png'), 32, 32, [200, 100, 0])
    await pngAt(join(raw, 'orange_mushroom', 'walk.png'), 32, 32, [180, 100, 0])
    const r = await importFromRawDir({ rawDir: raw, templatesDir: templates })
    const m = JSON.parse(readFileSync(r.manifestPath, 'utf8'))
    const variants = m.templates.map((t: { variant: string }) => t.variant).sort()
    expect(variants).toEqual(['idle', 'move'])
  })

  it('treats _player as canonical class "player" (no mob_ prefix)', async () => {
    mkdirSync(join(raw, '_player'))
    await pngAt(join(raw, '_player', 'stand.png'), 32, 48, [50, 50, 200])
    mkdirSync(join(raw, 'green_snail'))
    await pngAt(join(raw, 'green_snail', 'stand.png'), 32, 32, [0, 200, 0])
    const r = await importFromRawDir({ rawDir: raw, templatesDir: templates })
    const m = JSON.parse(readFileSync(r.manifestPath, 'utf8'))
    const classes = new Set(m.templates.map((t: { class: string }) => t.class))
    expect(classes.has('player')).toBe(true)
    expect(classes.has('mob_green_snail')).toBe(true)
  })

  it('rejects unknown underscore folders with a clear error', async () => {
    mkdirSync(join(raw, '_bogus'))
    await pngAt(join(raw, '_bogus', 'stand.png'), 32, 32, [0, 0, 0])
    await expect(
      importFromRawDir({ rawDir: raw, templatesDir: templates }),
    ).rejects.toThrow(/_bogus/)
  })

  it('skips zero-size and tiny PNGs with a warning', async () => {
    mkdirSync(join(raw, 'snail'))
    await pngAt(join(raw, 'snail', 'tiny.png'), 4, 4, [0, 200, 0])
    await pngAt(join(raw, 'snail', 'normal.png'), 32, 32, [0, 200, 0])
    const r = await importFromRawDir({ rawDir: raw, templatesDir: templates })
    expect(r.variants).toBe(1)
    expect(r.warnings.some((w) => w.includes('too small'))).toBe(true)
  })

  it('throws when raw dir has no subfolders', async () => {
    writeFileSync(join(raw, 'orphan.txt'), '')
    await expect(
      importFromRawDir({ rawDir: raw, templatesDir: templates }),
    ).rejects.toThrow(/no subfolders/)
  })

  it('throws when no usable PNGs found', async () => {
    mkdirSync(join(raw, 'snail'))
    // No PNGs in the folder.
    writeFileSync(join(raw, 'snail', 'notes.md'), '')
    await expect(
      importFromRawDir({ rawDir: raw, templatesDir: templates }),
    ).rejects.toThrow(/no usable PNGs/)
  })
})
