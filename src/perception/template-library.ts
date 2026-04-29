import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { findMatchesAsync, type TemplateMatch } from './template-match'
import { nonMaxSuppression } from './nms'
import type { Detection, PerceptionFrame } from '@/core/types'

export const ManifestEntry = z.object({
  file: z.string(),
  class: z.string(),
  source_frame: z.string().optional(),
  bbox_in_source: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  variant: z.string().optional(),
})
export const Manifest = z.object({
  templates: z.array(ManifestEntry).min(1),
})
export type Manifest = z.infer<typeof Manifest>

interface LoadedTemplate {
  class: string
  variant: string
  rgb: Buffer
  w: number
  h: number
}

export class TemplateLibrary {
  private constructor(
    public readonly dir: string,
    private readonly templates: LoadedTemplate[],
  ) {}

  static async load(dir: string): Promise<TemplateLibrary> {
    const text = await readFile(join(dir, 'manifest.json'), 'utf8')
    const parsed = Manifest.parse(JSON.parse(text))
    const loaded: LoadedTemplate[] = []
    for (const entry of parsed.templates) {
      const buf = await readFile(join(dir, entry.file))
      const img = sharp(buf)
      const meta = await img.metadata()
      if (!meta.width || !meta.height) {
        throw new Error(`template ${entry.file}: missing dimensions`)
      }
      const rgb = await img.removeAlpha().raw().toBuffer()
      loaded.push({
        class: entry.class,
        variant: entry.variant ?? 'default',
        rgb,
        w: meta.width,
        h: meta.height,
      })
    }
    return new TemplateLibrary(dir, loaded)
  }

  /**
   * Run every loaded template against the haystack, apply per-class NMS,
   * and produce a PerceptionFrame.
   */
  async detectFrame(
    haystackRgb: Buffer,
    hw: number,
    hh: number,
    threshold: number,
    stride: number = 2,
  ): Promise<PerceptionFrame> {
    const all: TemplateMatch[] = []
    for (const t of this.templates) {
      const matches = await findMatchesAsync(
        haystackRgb,
        hw,
        hh,
        t.rgb,
        t.w,
        t.h,
        t.class,
        threshold,
        stride,
      )
      all.push(...matches)
    }
    const detections: Detection[] = all.map((m) => ({
      class: m.class,
      bbox: m.bbox,
      confidence: Math.max(0, Math.min(1, m.score)), // ZNCC is in [-1,+1]; clamp
    }))
    const suppressed = nonMaxSuppression(detections, 0.3)
    return {
      timestamp: Date.now(),
      detections: suppressed,
      screenshotMeta: { width: hw, height: hh },
      overallConfidence: suppressed.reduce((m, d) => Math.max(m, d.confidence), 0),
    }
  }

  size(): number {
    return this.templates.length
  }
  classes(): string[] {
    return [...new Set(this.templates.map((t) => t.class))]
  }
}
