import type { Action } from '@/core/types'
import type { Clock } from '@/core/clock'

export function redPixelRatio(rgba: Buffer): number {
  const px = rgba.length / 4
  let red = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i],
      g = rgba[i + 1],
      b = rgba[i + 2]
    if (r > 150 && g < 80 && b < 80) red++
  }
  return red / px
}

export function bluePixelRatio(rgba: Buffer): number {
  const px = rgba.length / 4
  let blue = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i],
      g = rgba[i + 1],
      b = rgba[i + 2]
    if (b > 150 && r < 80 && g < 100) blue++
  }
  return blue / px
}

export function greenPixelRatio(rgba: Buffer): number {
  const px = rgba.length / 4
  let green = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i],
      g = rgba[i + 1],
      b = rgba[i + 2]
    if (g > 150 && r < 80 && b < 80) green++
  }
  return green / px
}

export type Metric = 'red_pixel_ratio' | 'blue_pixel_ratio' | 'green_pixel_ratio'

export function metricValue(m: Metric, rgba: Buffer): number {
  switch (m) {
    case 'red_pixel_ratio':
      return redPixelRatio(rgba)
    case 'blue_pixel_ratio':
      return bluePixelRatio(rgba)
    case 'green_pixel_ratio':
      return greenPixelRatio(rgba)
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
      if (buf.length === 0) continue
      const v = metricValue(c.metric, buf)
      this.vitals[c.region] = v
      if (v >= c.below) continue
      const last = this.lastFiredAt.get(c.region) ?? -Infinity
      if (this.clock.now() - last < c.cooldownMs) continue
      this.lastFiredAt.set(c.region, this.clock.now())
      this.submit(c.action)
    }
  }
}
