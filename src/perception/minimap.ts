import type { Vec2, Rect } from '@/core/types'

export interface DotMatcher {
  rgb: [number, number, number]
  tolerance: number
}

export function findPlayerDot(rgba: Buffer, w: number, h: number, m: DotMatcher): Vec2 | null {
  let sumX = 0,
    sumY = 0,
    count = 0
  const [tr, tg, tb] = m.rgb
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const dr = Math.abs(rgba[i] - tr)
      const dg = Math.abs(rgba[i + 1] - tg)
      const db = Math.abs(rgba[i + 2] - tb)
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
}

export class MinimapSampler {
  constructor(private opts: MinimapSamplerOpts) {}

  async sample(): Promise<Vec2 | null> {
    const buf = await this.opts.captureRegion(this.opts.region)
    return findPlayerDot(buf, this.opts.region.w, this.opts.region.h, this.opts.matcher)
  }
}
