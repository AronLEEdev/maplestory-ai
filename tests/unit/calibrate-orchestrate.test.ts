import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import YAML from 'yaml'
import { orchestrateSave, sampleColor, type SaveBody } from '@/calibrate/orchestrate'

let root: string

async function makeFakeScreenshot(): Promise<Buffer> {
  // 800×600 mostly mid-gray with three solid color blobs to extract from.
  const w = 800,
    h = 600
  const buf = Buffer.alloc(w * h * 3, 100)
  // HP region [50,40 → 150,60] red
  for (let y = 40; y < 60; y++)
    for (let x = 50; x < 150; x++) {
      const i = (y * w + x) * 3
      buf[i] = 200
      buf[i + 1] = 0
      buf[i + 2] = 0
    }
  // MP region [200,40 → 300,60] blue
  for (let y = 40; y < 60; y++)
    for (let x = 200; x < 300; x++) {
      const i = (y * w + x) * 3
      buf[i] = 0
      buf[i + 1] = 100
      buf[i + 2] = 230
    }
  // Minimap region [600,10 → 780,180] dark with a yellow dot at local (40, 50)
  for (let y = 10; y < 180; y++)
    for (let x = 600; x < 780; x++) {
      const i = (y * w + x) * 3
      buf[i] = 30
      buf[i + 1] = 30
      buf[i + 2] = 30
    }
  // yellow player dot at minimap-local (40, 50) → display-space (640, 60)
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const i = ((60 + dy) * w + (640 + dx)) * 3
      buf[i] = 255
      buf[i + 1] = 230
      buf[i + 2] = 60
    }
  // Mob sprite at [400,300 → 460,360] green-with-black-dot
  for (let y = 300; y < 360; y++)
    for (let x = 400; x < 460; x++) {
      const i = (y * w + x) * 3
      buf[i] = 50
      buf[i + 1] = 200
      buf[i + 2] = 80
    }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cal-orch-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('sampleColor', () => {
  it('reads RGB at the requested coord', async () => {
    const png = await makeFakeScreenshot()
    const rgb = await sampleColor(png, { x: 640, y: 60 })
    // Yellow dot color
    expect(rgb[0]).toBeGreaterThan(200)
    expect(rgb[1]).toBeGreaterThan(200)
    expect(rgb[2]).toBeLessThan(100)
  })

  it('clamps out-of-bounds coords', async () => {
    const png = await makeFakeScreenshot()
    const rgb = await sampleColor(png, { x: 9999, y: -50 })
    expect(rgb).toHaveLength(3)
    expect(rgb.every((c) => c >= 0 && c <= 255)).toBe(true)
  })
})

describe('orchestrateSave', () => {
  it('end-to-end happy path: writes valid routine YAML pointing at YOLO model', async () => {
    const png = await makeFakeScreenshot()
    const body: SaveBody = {
      windowTitle: 'MapleStory Worlds',
      regions: {
        hp: { x: 50, y: 40, w: 100, h: 20 },
        mp: { x: 200, y: 40, w: 100, h: 20 },
        minimap: { x: 600, y: 10, w: 180, h: 170 },
      },
      playerDotAt: { x: 640, y: 60 },
      bounds: { topLeft: { x: 10, y: 30 }, bottomRight: { x: 170, y: 160 } },
      waypointXs: [25, 150],
      mobCrops: [],
    }
    const result = await orchestrateSave({
      map: 'henesys',
      screenshotPng: png,
      body,
      routinesDir: join(root, 'routines'),
      spritesRawDir: join(root, 'sprites-raw'),
      templatesDir: join(root, 'templates'),
    })
    expect(existsSync(result.routinePath)).toBe(true)
    expect(result.templatesWritten).toBe(0)

    const routine = YAML.parse(readFileSync(result.routinePath, 'utf8'))
    expect(routine.window_title).toBe('MapleStory Worlds')
    expect(routine.regions.hp).toEqual({ x: 50, y: 40, w: 100, h: 20 })
    expect(routine.minimap_player_color.rgb[0]).toBeGreaterThan(200)
    expect(routine.bounds.x).toEqual([10, 170])
    expect(routine.bounds.y).toEqual([30, 160])
    expect(routine.movement.primitives[0]).toEqual({ op: 'walk_to_x', x: 25 })
    expect(routine.perception.model_path).toBe('data/models/henesys.onnx')
  })

  it('writes the v2 sidecar JSON next to the routine yaml', async () => {
    const png = await makeFakeScreenshot()
    const body: SaveBody = {
      windowTitle: 'MapleStory Worlds',
      regions: {
        hp: { x: 50, y: 40, w: 100, h: 20 },
        mp: { x: 200, y: 40, w: 100, h: 20 },
        minimap: { x: 600, y: 10, w: 180, h: 170 },
      },
      playerDotAt: { x: 640, y: 60 },
      bounds: { topLeft: { x: 10, y: 30 }, bottomRight: { x: 170, y: 160 } },
      waypointXs: [25, 150],
      mobCrops: [],
    }
    await orchestrateSave({
      map: 'henesys',
      screenshotPng: png,
      body,
      routinesDir: join(root, 'routines'),
      spritesRawDir: join(root, 'sprites-raw'),
      templatesDir: join(root, 'templates'),
    })
    const sidecar = join(root, 'routines', '.calibrate', 'henesys.json')
    expect(existsSync(sidecar)).toBe(true)
    const data = JSON.parse(readFileSync(sidecar, 'utf8'))
    expect(data.body.windowTitle).toBe('MapleStory Worlds')
  })
})
