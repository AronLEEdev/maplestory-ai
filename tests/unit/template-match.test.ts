import { describe, it, expect } from 'vitest'
import { findMatches, rgbToLuminance } from '@/perception/template-match'

/**
 * Build an RGBA buffer of size w*h with a solid color background and an
 * optional embedded "stamp" rectangle at (sx, sy) of size (sw, sh).
 */
function makeImage(
  w: number,
  h: number,
  bg: [number, number, number],
  stamp?: { x: number; y: number; w: number; h: number; rgb: [number, number, number] },
): Buffer {
  const buf = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      buf[i] = bg[0]
      buf[i + 1] = bg[1]
      buf[i + 2] = bg[2]
    }
  }
  if (stamp) {
    for (let y = 0; y < stamp.h; y++) {
      for (let x = 0; x < stamp.w; x++) {
        const px = stamp.x + x,
          py = stamp.y + y
        if (px < 0 || py < 0 || px >= w || py >= h) continue
        const i = (py * w + px) * 3
        buf[i] = stamp.rgb[0]
        buf[i + 1] = stamp.rgb[1]
        buf[i + 2] = stamp.rgb[2]
      }
    }
  }
  return buf
}

describe('rgbToLuminance', () => {
  it('flattens RGB → grayscale buffer of length w*h', () => {
    const rgb = makeImage(4, 4, [128, 128, 128])
    const lum = rgbToLuminance(rgb, 4, 4)
    expect(lum.length).toBe(16)
    // Mid-gray should map to ~128.
    expect(lum[0]).toBeGreaterThan(120)
    expect(lum[0]).toBeLessThan(140)
  })
})

/**
 * Build a structured template: outer rect of color A, inner rect of color B.
 * Real mob sprites have this kind of internal contrast; flat-color templates
 * cause sigma=0 and ZNCC is undefined.
 */
function makeStructuredTemplate(
  w: number,
  h: number,
  outer: [number, number, number],
  inner: [number, number, number],
): Buffer {
  const buf = makeImage(w, h, outer)
  const ix = Math.floor(w / 4),
    iy = Math.floor(h / 4)
  const iw = Math.max(1, Math.floor(w / 2)),
    ih = Math.max(1, Math.floor(h / 2))
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const px = ix + x,
        py = iy + y
      const i = (py * w + px) * 3
      buf[i] = inner[0]
      buf[i + 1] = inner[1]
      buf[i + 2] = inner[2]
    }
  }
  return buf
}

/**
 * Stamp a structured template into a haystack image at (sx, sy).
 */
function stampStructuredInto(
  haystack: Buffer,
  hw: number,
  sx: number,
  sy: number,
  template: Buffer,
  tw: number,
  th: number,
) {
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const px = sx + x,
        py = sy + y
      const hi = (py * hw + px) * 3
      const ti = (y * tw + x) * 3
      haystack[hi] = template[ti]
      haystack[hi + 1] = template[ti + 1]
      haystack[hi + 2] = template[ti + 2]
    }
  }
}

describe('findMatches', () => {
  it('finds the template at the exact position with score ~1.0', () => {
    const template = makeStructuredTemplate(10, 10, [255, 0, 0], [0, 0, 0])
    const haystack = makeImage(100, 100, [50, 50, 50])
    stampStructuredInto(haystack, 100, 30, 40, template, 10, 10)
    const matches = findMatches(haystack, 100, 100, template, 10, 10, 'red', 0.9, 1)
    expect(matches.length).toBeGreaterThan(0)
    const best = matches.sort((a, b) => b.score - a.score)[0]
    expect(best.bbox[0]).toBe(30)
    expect(best.bbox[1]).toBe(40)
    expect(best.score).toBeGreaterThan(0.9)
    expect(best.class).toBe('red')
  })

  it('returns no matches when template is not present', () => {
    const haystack = makeImage(50, 50, [200, 200, 200])
    const template = makeStructuredTemplate(8, 8, [255, 0, 0], [0, 0, 0])
    const matches = findMatches(haystack, 50, 50, template, 8, 8, 'red', 0.7)
    expect(matches.length).toBe(0)
  })

  it('filters out matches below the threshold', () => {
    const template = makeStructuredTemplate(8, 8, [255, 0, 0], [0, 0, 0])
    const haystack = makeImage(50, 50, [100, 100, 100])
    // Stamp a same-shape but very faint version (low contrast → low ZNCC).
    const faint = makeStructuredTemplate(8, 8, [110, 100, 100], [100, 110, 100])
    stampStructuredInto(haystack, 50, 10, 10, faint, 8, 8)
    const matches = findMatches(haystack, 50, 50, template, 8, 8, 'red', 0.99, 1)
    expect(matches.length).toBe(0)
  })

  it('finds multiple instances of the same template', () => {
    const template = makeStructuredTemplate(10, 10, [0, 255, 0], [0, 0, 0])
    const haystack = makeImage(80, 40, [128, 128, 128])
    stampStructuredInto(haystack, 80, 5, 10, template, 10, 10)
    stampStructuredInto(haystack, 80, 60, 10, template, 10, 10)
    const matches = findMatches(haystack, 80, 40, template, 10, 10, 'green', 0.9, 1)
    const strong = matches.filter((m) => m.score > 0.95)
    expect(strong.length).toBeGreaterThanOrEqual(2)
  })

  it('completes 4-template scan of 600x400 region in <200ms', () => {
    const template = makeStructuredTemplate(40, 40, [255, 0, 0], [0, 0, 0])
    const haystack = makeImage(600, 400, [80, 80, 80])
    stampStructuredInto(haystack, 600, 200, 150, template, 40, 40)
    const t0 = Date.now()
    for (let i = 0; i < 4; i++) {
      findMatches(haystack, 600, 400, template, 40, 40, 'red', 0.7)
    }
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(200)
  })
})
