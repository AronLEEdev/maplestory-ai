import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { findMatchesWithDiag, type TemplateMatch } from './template-match'
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

export interface TemplateDiag {
  class: string
  variant: string
  templateW: number
  templateH: number
  bestScore: number
  bestPos: { x: number; y: number } | null
  matchesAboveThreshold: number
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
   * and produce a PerceptionFrame. Also returns per-template diag info so
   * callers can see best ZNCC scores even when no match cleared threshold.
   */
  async detectFrame(
    haystackRgb: Buffer,
    hw: number,
    hh: number,
    threshold: number,
    stride: number = 2,
    /** Max detections to keep per class after NMS. Caps damage from a single
     *  noisy template (e.g. one cropped on non-distinctive background pixels)
     *  flooding the perception frame with false positives. */
    maxPerClass: number = 8,
  ): Promise<{ frame: PerceptionFrame; diag: TemplateDiag[] }> {
    const all: TemplateMatch[] = []
    const diag: TemplateDiag[] = []
    for (const t of this.templates) {
      const r = await findMatchesWithDiag(
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
      all.push(...r.matches)
      diag.push({
        class: t.class,
        variant: t.variant,
        templateW: t.w,
        templateH: t.h,
        bestScore: Number(r.bestScore.toFixed(3)),
        bestPos: r.bestPos,
        matchesAboveThreshold: r.matches.length,
      })
    }
    const detections: Detection[] = all.map((m) => ({
      class: m.class,
      bbox: m.bbox,
      confidence: Math.max(0, Math.min(1, m.score)),
    }))
    const suppressed = nonMaxSuppression(detections, 0.3)
    // Top-K per class: keep only the highest-confidence matches per class so
    // a single misbehaving template can't drown the frame in false positives.
    const perClass = new Map<string, Detection[]>()
    for (const d of suppressed) {
      const arr = perClass.get(d.class) ?? []
      arr.push(d)
      perClass.set(d.class, arr)
    }
    const capped: Detection[] = []
    for (const arr of perClass.values()) {
      arr.sort((a, b) => b.confidence - a.confidence)
      capped.push(...arr.slice(0, maxPerClass))
    }
    return {
      frame: {
        timestamp: Date.now(),
        detections: capped,
        screenshotMeta: { width: hw, height: hh },
        overallConfidence: capped.reduce((m, d) => Math.max(m, d.confidence), 0),
      },
      diag,
    }
  }

  size(): number {
    return this.templates.length
  }
  classes(): string[] {
    return [...new Set(this.templates.map((t) => t.class))]
  }
  /** Per-template dimensions for diagnostic logging. */
  dims(): Array<{ class: string; variant: string; w: number; h: number }> {
    return this.templates.map((t) => ({ class: t.class, variant: t.variant, w: t.w, h: t.h }))
  }
}
