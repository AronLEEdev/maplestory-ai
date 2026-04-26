import type { Detection } from '@/core/types'

function iou(a: Detection['bbox'], b: Detection['bbox']): number {
  const [ax, ay, aw, ah] = a
  const [bx, by, bw, bh] = b
  const x1 = Math.max(ax, bx),
    y1 = Math.max(ay, by)
  const x2 = Math.min(ax + aw, bx + bw),
    y2 = Math.min(ay + ah, by + bh)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = aw * ah + bw * bh - inter
  return union > 0 ? inter / union : 0
}

export function nonMaxSuppression(dets: Detection[], iouThresh = 0.5): Detection[] {
  const byClass = new Map<string, Detection[]>()
  for (const d of dets) {
    if (!byClass.has(d.class)) byClass.set(d.class, [])
    byClass.get(d.class)!.push(d)
  }
  const out: Detection[] = []
  for (const list of byClass.values()) {
    list.sort((a, b) => b.confidence - a.confidence)
    const kept: Detection[] = []
    for (const d of list) {
      if (kept.every((k) => iou(k.bbox, d.bbox) < iouThresh)) kept.push(d)
    }
    out.push(...kept)
  }
  return out
}
