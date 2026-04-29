import type { Action } from '@/core/types'
import type { Clock } from '@/core/clock'
import { logger } from '@/core/logger'

/**
 * The runtime captureRegion path returns a 3-channel RGB buffer (after
 * removeAlpha()). Earlier versions assumed 4-channel RGBA and indexed with
 * a stride of 4 bytes — silently reading the wrong pixels. All pixel-ratio
 * functions below now use the canonical 3-channel stride.
 */
const STRIDE = 3

/**
 * Count pixels that are **bright AND colorful** — i.e. the lit portion of
 * a colored bar. Excludes both dark backgrounds AND bright gray empty-bar
 * troughs.
 *
 * Two checks per pixel:
 *   1. max(R,G,B) >= brightness  — pixel is not in shadow
 *   2. max - min  >= saturation  — pixel is colored, not gray
 *
 * This works uniformly for red HP, blue MP, green stamina, magenta MP, etc.
 * Empty bar troughs (which are usually mid-gray, e.g. [100,100,100]) fail
 * the saturation test — `max-min ≈ 0`.
 */
export function fillRatio(rgb: Buffer, brightness = 80, saturation = 50): number {
  const px = rgb.length / STRIDE
  if (px === 0) return 0
  let lit = 0
  for (let i = 0; i < rgb.length; i += STRIDE) {
    const r = rgb[i]
    const g = rgb[i + 1]
    const b = rgb[i + 2]
    const max = r >= g ? (r >= b ? r : b) : g >= b ? g : b
    const min = r <= g ? (r <= b ? r : b) : g <= b ? g : b
    if (max >= brightness && max - min >= saturation) lit++
  }
  return lit / px
}

export function redPixelRatio(rgb: Buffer): number {
  const px = rgb.length / STRIDE
  if (px === 0) return 0
  let red = 0
  for (let i = 0; i < rgb.length; i += STRIDE) {
    const r = rgb[i],
      g = rgb[i + 1],
      b = rgb[i + 2]
    if (r > 150 && g < 80 && b < 80) red++
  }
  return red / px
}

export function bluePixelRatio(rgb: Buffer): number {
  const px = rgb.length / STRIDE
  if (px === 0) return 0
  let blue = 0
  for (let i = 0; i < rgb.length; i += STRIDE) {
    const r = rgb[i],
      g = rgb[i + 1],
      b = rgb[i + 2]
    if (b > 150 && r < 80 && g < 100) blue++
  }
  return blue / px
}

export function greenPixelRatio(rgb: Buffer): number {
  const px = rgb.length / STRIDE
  if (px === 0) return 0
  let green = 0
  for (let i = 0; i < rgb.length; i += STRIDE) {
    const r = rgb[i],
      g = rgb[i + 1],
      b = rgb[i + 2]
    if (g > 150 && r < 80 && b < 80) green++
  }
  return green / px
}

export type Metric =
  | 'fill_ratio'
  | 'red_pixel_ratio'
  | 'blue_pixel_ratio'
  | 'green_pixel_ratio'

export function metricValue(m: Metric, rgb: Buffer): number {
  switch (m) {
    case 'fill_ratio':
      return fillRatio(rgb)
    case 'red_pixel_ratio':
      return redPixelRatio(rgb)
    case 'blue_pixel_ratio':
      return bluePixelRatio(rgb)
    case 'green_pixel_ratio':
      return greenPixelRatio(rgb)
  }
}

export interface ReflexCheck {
  region: string
  metric: Metric
  below: number
  cooldownMs: number
  action: Action
}

export interface ReflexWorkerOpts {
  clock: Clock
  submit: (a: Action) => void
  checks: ReflexCheck[]
  sample: (region: string) => Promise<Buffer>
}

export class ReflexWorker {
  private clock: Clock
  private submit: (a: Action) => void
  private checks: ReflexCheck[]
  private sample: (region: string) => Promise<Buffer>
  private lastFiredAt = new Map<string, number>()
  private vitals: Record<string, number> = { hp: 1, mp: 1 }

  constructor(opts: ReflexWorkerOpts) {
    this.clock = opts.clock
    this.submit = opts.submit
    this.checks = opts.checks
    this.sample = opts.sample
  }

  current(): { hp: number; mp: number } {
    return { hp: this.vitals.hp ?? 1, mp: this.vitals.mp ?? 1 }
  }

  async tick(): Promise<void> {
    for (const c of this.checks) {
      const buf = await this.sample(c.region)
      if (buf.length === 0) {
        logger.warn({ region: c.region }, 'reflex: sample returned empty buffer — region rect probably out of screen bounds')
        continue
      }
      const v = metricValue(c.metric, buf)
      this.vitals[c.region] = v
      if (v >= c.below) continue
      const last = this.lastFiredAt.get(c.region) ?? -Infinity
      if (this.clock.now() - last < c.cooldownMs) continue
      this.lastFiredAt.set(c.region, this.clock.now())
      logger.info(
        {
          region: c.region,
          value: Number(v.toFixed(3)),
          threshold: c.below,
          action: c.action,
        },
        'reflex: firing — submitting action',
      )
      this.submit(c.action)
    }
  }
}
