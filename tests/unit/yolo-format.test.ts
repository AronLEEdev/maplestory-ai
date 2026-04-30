import { describe, it, expect } from 'vitest'
import {
  CLASS_NAMES,
  classIdOf,
  classNameOf,
  pixelToYolo,
  yoloToPixel,
  serializeYolo,
  parseYolo,
} from '@/dataset/yolo-format'

describe('class id mapping', () => {
  it('maps player↔0 and mob↔1', () => {
    expect(classIdOf('player')).toBe(0)
    expect(classIdOf('mob')).toBe(1)
    expect(classNameOf(0)).toBe('player')
    expect(classNameOf(1)).toBe('mob')
    expect(classNameOf(99)).toBeNull()
    expect(CLASS_NAMES.length).toBe(2)
  })
})

describe('pixelToYolo / yoloToPixel', () => {
  it('round-trips a pixel rect through YOLO normalization', () => {
    const pix = { classId: 1, x: 100, y: 200, w: 60, h: 80 }
    const y = pixelToYolo(pix, 640, 480)
    expect(y.classId).toBe(1)
    expect(y.cx).toBeCloseTo((100 + 30) / 640, 5)
    expect(y.cy).toBeCloseTo((200 + 40) / 480, 5)
    expect(y.w).toBeCloseTo(60 / 640, 5)
    expect(y.h).toBeCloseTo(80 / 480, 5)
    const back = yoloToPixel(y, 640, 480)
    expect(back.x).toBeCloseTo(100, 3)
    expect(back.y).toBeCloseTo(200, 3)
    expect(back.w).toBeCloseTo(60, 3)
    expect(back.h).toBeCloseTo(80, 3)
  })

  it('clamps out-of-image pixel boxes into [0,1]', () => {
    const y = pixelToYolo({ classId: 0, x: -10, y: -10, w: 10, h: 10 }, 100, 100)
    expect(y.cx).toBeGreaterThanOrEqual(0)
    expect(y.cy).toBeGreaterThanOrEqual(0)
    expect(y.w).toBeLessThanOrEqual(1)
    expect(y.h).toBeLessThanOrEqual(1)
  })
})

describe('serialize / parse round-trip', () => {
  it('survives multi-line content with comments and blank lines', () => {
    const txt = `
# header comment
0 0.5 0.5 0.3 0.4

1 0.2 0.7 0.1 0.15  # mob at lower-left
`
    const boxes = parseYolo(txt)
    expect(boxes).toEqual([
      { classId: 0, cx: 0.5, cy: 0.5, w: 0.3, h: 0.4 },
      { classId: 1, cx: 0.2, cy: 0.7, w: 0.1, h: 0.15 },
    ])
    const re = parseYolo(serializeYolo(boxes))
    for (let i = 0; i < boxes.length; i++) {
      expect(re[i].classId).toBe(boxes[i].classId)
      expect(re[i].cx).toBeCloseTo(boxes[i].cx, 5)
      expect(re[i].cy).toBeCloseTo(boxes[i].cy, 5)
      expect(re[i].w).toBeCloseTo(boxes[i].w, 5)
      expect(re[i].h).toBeCloseTo(boxes[i].h, 5)
    }
  })

  it('throws on malformed lines', () => {
    expect(() => parseYolo('0 0.5 0.5 0.3')).toThrow()
    expect(() => parseYolo('x 0.5 0.5 0.3 0.4')).toThrow()
  })
})
