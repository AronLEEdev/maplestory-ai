import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { Manifest, TemplateLibrary } from '@/perception/template-library'

let dir: string

/**
 * Write a structured 16x16 PNG: outer color, with a small dark block at
 * a class-specific position so different classes have distinct LUMINANCE
 * shapes (not just colors — ZNCC works on luminance).
 */
async function writeStructuredPng(
  path: string,
  outer: [number, number, number],
  darkBlock: { x: number; y: number; w: number; h: number },
) {
  const w = 16,
    h = 16
  const buf = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    buf[i * 3] = outer[0]
    buf[i * 3 + 1] = outer[1]
    buf[i * 3 + 2] = outer[2]
  }
  for (let y = 0; y < darkBlock.h; y++) {
    for (let x = 0; x < darkBlock.w; x++) {
      const px = darkBlock.x + x,
        py = darkBlock.y + y
      if (px < 0 || py < 0 || px >= w || py >= h) continue
      const i = (py * w + px) * 3
      buf[i] = 0
      buf[i + 1] = 0
      buf[i + 2] = 0
    }
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(path)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tlib-'))
  // mob_a: dark block in top-left.
  await writeStructuredPng(join(dir, 'mob_a.png'), [255, 0, 0], { x: 2, y: 2, w: 6, h: 6 })
  // mob_b: dark block in bottom-right — different luminance pattern.
  await writeStructuredPng(join(dir, 'mob_b.png'), [0, 255, 0], { x: 8, y: 8, w: 6, h: 6 })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      templates: [
        { file: 'mob_a.png', class: 'mob_a', variant: 'idle' },
        { file: 'mob_b.png', class: 'mob_b', variant: 'idle' },
      ],
    }),
  )
})

describe('Manifest schema', () => {
  it('requires non-empty templates array', () => {
    expect(() => Manifest.parse({ templates: [] })).toThrow()
  })
  it('rejects entry without file or class', () => {
    expect(() => Manifest.parse({ templates: [{ file: 'a.png' }] })).toThrow()
  })
})

describe('TemplateLibrary', () => {
  it('loads manifest + PNG templates', async () => {
    const lib = await TemplateLibrary.load(dir)
    expect(lib.size()).toBe(2)
    expect(lib.classes().sort()).toEqual(['mob_a', 'mob_b'])
  })

  it('detectFrame finds embedded templates', async () => {
    const lib = await TemplateLibrary.load(dir)
    // Build a haystack: 100x60 mid-gray, stamp mob_a at (10,10), mob_b at (60,10).
    const hw = 100,
      hh = 60
    const haystack = Buffer.alloc(hw * hh * 3, 128)
    const stamp = async (x: number, y: number, color: 'a' | 'b') => {
      const path = join(dir, color === 'a' ? 'mob_a.png' : 'mob_b.png')
      const tplBuf = await sharp(path).removeAlpha().raw().toBuffer()
      for (let dy = 0; dy < 16; dy++) {
        for (let dx = 0; dx < 16; dx++) {
          const hi = ((y + dy) * hw + (x + dx)) * 3
          const ti = (dy * 16 + dx) * 3
          haystack[hi] = tplBuf[ti]
          haystack[hi + 1] = tplBuf[ti + 1]
          haystack[hi + 2] = tplBuf[ti + 2]
        }
      }
    }
    await stamp(10, 10, 'a')
    await stamp(60, 10, 'b')
    const { frame, diag } = await lib.detectFrame(haystack, hw, hh, 0.95, 1)
    expect(diag.length).toBe(2) // one diag entry per template
    const classes = new Set(frame.detections.map((d) => d.class))
    expect(classes.has('mob_a')).toBe(true)
    expect(classes.has('mob_b')).toBe(true)
    // Each class should NMS down to a single best detection per stamp.
    expect(frame.detections.filter((d) => d.class === 'mob_a').length).toBe(1)
    expect(frame.detections.filter((d) => d.class === 'mob_b').length).toBe(1)
  })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
