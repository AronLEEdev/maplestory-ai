import { describe, it, expect } from 'vitest'
import { nonMaxSuppression } from '@/perception/nms'
import type { Detection } from '@/core/types'

describe('nonMaxSuppression', () => {
  it('removes overlapping lower-confidence boxes', () => {
    const dets: Detection[] = [
      { class: 'mob', bbox: [0, 0, 100, 100], confidence: 0.9 },
      { class: 'mob', bbox: [10, 10, 100, 100], confidence: 0.5 },
      { class: 'mob', bbox: [500, 500, 50, 50], confidence: 0.7 },
    ]
    const out = nonMaxSuppression(dets, 0.5)
    expect(out.length).toBe(2)
    expect(out.map((d) => d.confidence)).toContain(0.9)
    expect(out.map((d) => d.confidence)).toContain(0.7)
  })

  it('respects per-class boundary', () => {
    const dets: Detection[] = [
      { class: 'mob', bbox: [0, 0, 100, 100], confidence: 0.9 },
      { class: 'player', bbox: [0, 0, 100, 100], confidence: 0.95 },
    ]
    const out = nonMaxSuppression(dets, 0.5)
    expect(out.length).toBe(2)
  })
})
