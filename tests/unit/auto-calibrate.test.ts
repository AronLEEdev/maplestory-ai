import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { cropTemplates } from '@/perception/auto-calibrate'

let calibrationDir: string
let templatesDir: string

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'cal-'))
  calibrationDir = join(root, 'cal')
  templatesDir = join(root, 'templates')
  mkdirSync(join(calibrationDir, 'frames'), { recursive: true })
  // Build a 200x200 frame with a recognisable square at (50, 60).
  const w = 200,
    h = 200
  const buf = Buffer.alloc(w * h * 3, 200)
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 50; x++) {
      const i = ((60 + y) * w + (50 + x)) * 3
      buf[i] = 255
      buf[i + 1] = 0
      buf[i + 2] = 0
    }
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(join(calibrationDir, 'frames', '0001.png'))
  writeFileSync(
    join(calibrationDir, 'manifest-source.json'),
    JSON.stringify({
      templates: [
        {
          class: 'mob_test',
          variant: 'idle',
          source_frame: 'frames/0001.png',
          bbox_in_source: [50, 60, 50, 40],
        },
      ],
    }),
  )
})

afterEach(() => {
  rmSync(join(calibrationDir, '..'), { recursive: true, force: true })
})

describe('cropTemplates', () => {
  it('crops the bbox and writes manifest.json', async () => {
    const r = await cropTemplates({ calibrationDir, templatesDir })
    expect(r.templatesWritten).toBe(1)
    expect(existsSync(r.manifestPath)).toBe(true)
    expect(existsSync(join(templatesDir, 'mob_test-idle.png'))).toBe(true)
    const m = JSON.parse(readFileSync(r.manifestPath, 'utf8'))
    expect(m.templates[0].class).toBe('mob_test')
    expect(m.templates[0].variant).toBe('idle')
    expect(m.templates[0].file).toBe('mob_test-idle.png')

    // Verify the cropped PNG is the right dimensions.
    const meta = await sharp(join(templatesDir, 'mob_test-idle.png')).metadata()
    expect(meta.width).toBe(50)
    expect(meta.height).toBe(40)
  })

  it('disambiguates filenames when same class+variant repeats', async () => {
    const src = JSON.parse(
      readFileSync(join(calibrationDir, 'manifest-source.json'), 'utf8'),
    )
    src.templates.push({ ...src.templates[0] }) // duplicate entry
    writeFileSync(join(calibrationDir, 'manifest-source.json'), JSON.stringify(src))
    const r = await cropTemplates({ calibrationDir, templatesDir })
    expect(r.templatesWritten).toBe(2)
    expect(existsSync(join(templatesDir, 'mob_test-idle.png'))).toBe(true)
    expect(existsSync(join(templatesDir, 'mob_test-idle-2.png'))).toBe(true)
  })

  it('throws when manifest-source.json is missing', async () => {
    rmSync(join(calibrationDir, 'manifest-source.json'))
    await expect(cropTemplates({ calibrationDir, templatesDir })).rejects.toThrow(
      /manifest-source\.json not found/,
    )
  })
})
