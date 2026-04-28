export interface TemplateMatch {
  bbox: [number, number, number, number]
  score: number
  class: string
}

/**
 * Convert tightly-packed RGB (3 bytes/px) to luminance (1 byte/px).
 * Uses the standard Rec. 709 weights (0.2126R + 0.7152G + 0.0722B).
 */
export function rgbToLuminance(rgb: Buffer, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let i = 0, j = 0; j < out.length; i += 3, j++) {
    out[j] = (rgb[i] * 0.2126 + rgb[i + 1] * 0.7152 + rgb[i + 2] * 0.0722) | 0
  }
  return out
}

/**
 * Pre-compute the (zero-meaned) template buffer + sigma. The inner ZNCC loop
 * uses these to skip per-window template-mean recomputation.
 */
function templateStats(t: Uint8Array): { centered: Float32Array; sigma: number } {
  let sum = 0
  for (let i = 0; i < t.length; i++) sum += t[i]
  const mean = sum / t.length
  const centered = new Float32Array(t.length)
  let ss = 0
  for (let i = 0; i < t.length; i++) {
    const d = t[i] - mean
    centered[i] = d
    ss += d * d
  }
  return { centered, sigma: Math.sqrt(ss) }
}

/**
 * Build summed-area tables (integral images) for the haystack luminance,
 * one for the values and one for the squares. Stored as (w+1) x (h+1).
 *
 * After this:
 *  rectSum(x, y, w, h)    = I[y+h][x+w] - I[y+h][x] - I[y][x+w] + I[y][x]
 *  rectSumSq(x, y, w, h)  = same on Isq[]
 */
function integralImages(
  hLum: Uint8Array,
  w: number,
  h: number,
): { I: Float64Array; Isq: Float64Array } {
  const W = w + 1
  const I = new Float64Array(W * (h + 1))
  const Isq = new Float64Array(W * (h + 1))
  for (let y = 0; y < h; y++) {
    let rowSum = 0
    let rowSumSq = 0
    for (let x = 0; x < w; x++) {
      const v = hLum[y * w + x]
      rowSum += v
      rowSumSq += v * v
      const idx = (y + 1) * W + (x + 1)
      I[idx] = I[y * W + (x + 1)] + rowSum
      Isq[idx] = Isq[y * W + (x + 1)] + rowSumSq
    }
  }
  return { I, Isq }
}

/**
 * Sliding-window ZNCC over a haystack RGB buffer for one template.
 * Returns every position where score >= threshold.
 *
 * Optimizations over naive impl:
 *   - Luminance only (1 channel)
 *   - Integral image gives window mean + sigma in O(1) per position
 *   - Template centered once; inner cov loop is a single pass
 *   - `stride` controls coarse scanning. Default 2 => ~4x speedup with
 *     minimal recall loss for templates >=20px wide.
 */
export function findMatches(
  haystackRgb: Buffer,
  hw: number,
  hh: number,
  templateRgb: Buffer,
  tw: number,
  th: number,
  templateClass: string,
  threshold: number,
  stride: number = 2,
): TemplateMatch[] {
  if (tw > hw || th > hh) return []
  const hLum = rgbToLuminance(haystackRgb, hw, hh)
  const tLum = rgbToLuminance(templateRgb, tw, th)
  const { centered: tCentered, sigma: tSigma } = templateStats(tLum)
  if (tSigma === 0) return [] // template is a flat image — meaningless to match

  const { I, Isq } = integralImages(hLum, hw, hh)
  const W = hw + 1
  const N = tw * th

  const out: TemplateMatch[] = []
  for (let y = 0; y <= hh - th; y += stride) {
    const yEnd = y + th
    for (let x = 0; x <= hw - tw; x += stride) {
      const xEnd = x + tw
      // Window sum (and sum of squares) via integral images.
      const sum =
        I[yEnd * W + xEnd] - I[yEnd * W + x] - I[y * W + xEnd] + I[y * W + x]
      const sumSq =
        Isq[yEnd * W + xEnd] - Isq[yEnd * W + x] - Isq[y * W + xEnd] + Isq[y * W + x]
      const wMean = sum / N
      const wVar = sumSq - sum * wMean // = sum of squared deviations
      if (wVar <= 0) continue
      const wSigma = Math.sqrt(wVar)

      // Single pass over template region computing cov = Σ (haystack - wMean)(template - tMean).
      // Since tCentered already has tMean subtracted, and Σ tCentered = 0, we can simplify:
      //   cov = Σ haystack * tCentered  - wMean * Σ tCentered
      //       = Σ haystack * tCentered
      let cov = 0
      for (let dy = 0; dy < th; dy++) {
        const rowH = (y + dy) * hw + x
        const rowT = dy * tw
        for (let dx = 0; dx < tw; dx++) {
          cov += hLum[rowH + dx] * tCentered[rowT + dx]
        }
      }
      const score = cov / (wSigma * tSigma)
      if (score >= threshold) {
        out.push({ bbox: [x, y, tw, th], score, class: templateClass })
      }
    }
  }
  return out
}
