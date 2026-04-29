import type { Vec2, Rect } from '@/core/types'
import { logger } from '@/core/logger'

export interface DotMatcher {
  rgb: [number, number, number]
  tolerance: number
}

/**
 * Locate the centroid of pixels matching `m.rgb` within `m.tolerance`
 * (sum-of-channel-deltas) in a tightly-packed pixel buffer.
 *
 * `channels` defaults to 3 (RGB). Pass 4 if the buffer is RGBA. The runtime
 * capture path uses RGB after `removeAlpha()`; only callers that explicitly
 * decode with alpha need to pass 4.
 */
export function findPlayerDot(
  rgb: Buffer,
  w: number,
  h: number,
  m: DotMatcher,
  channels: 3 | 4 = 3,
): Vec2 | null {
  if (rgb.length !== w * h * channels) {
    logger.warn(
      { bufferLen: rgb.length, expected: w * h * channels, w, h, channels },
      'findPlayerDot: buffer size does not match w*h*channels — wrong stride?',
    )
  }
  let sumX = 0,
    sumY = 0,
    count = 0
  const [tr, tg, tb] = m.rgb
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * channels
      const dr = Math.abs(rgb[i] - tr)
      const dg = Math.abs(rgb[i + 1] - tg)
      const db = Math.abs(rgb[i + 2] - tb)
      if (dr + dg + db <= m.tolerance) {
        sumX += x
        sumY += y
        count++
      }
    }
  }
  if (count === 0) return null
  return { x: sumX / count, y: sumY / count }
}

export interface MinimapSamplerOpts {
  captureRegion: (r: Rect) => Promise<Buffer>
  region: Rect
  matcher: DotMatcher
  /** Buffer channels — 3 for RGB (default, runtime path), 4 for RGBA. */
  channels?: 3 | 4
}

export class MinimapSampler {
  constructor(private opts: MinimapSamplerOpts) {}

  async sample(): Promise<Vec2 | null> {
    try {
      const buf = await this.opts.captureRegion(this.opts.region)
      return findPlayerDot(
        buf,
        this.opts.region.w,
        this.opts.region.h,
        this.opts.matcher,
        this.opts.channels ?? 3,
      )
    } catch (err) {
      logger.warn({ err, region: this.opts.region }, 'MinimapSampler.sample failed')
      return null
    }
  }
}
