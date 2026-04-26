import { describe, it, expect } from 'vitest'
import { YoloPerception } from '@/perception/yolo'

// Build a fake Tensor + dims pair and feed it through the (private) parser via a
// thin subclass that exposes the method. The dims layout is the only thing
// being validated here.

class TestableYolo extends YoloPerception {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parse(out: any, w: number, h: number) {
    // @ts-expect-error access private for test
    return this.parseYoloOutput(out, w, h)
  }
}

function fakeTensor(dims: [number, number, number], data: Float32Array) {
  return { dims, data }
}

describe('YOLO output parser layout autodetect', () => {
  // 3 anchors, 2 classes (4 box + 2 cls = 6 attrs)
  const numClasses = 2
  const N = 3
  const numAttrs = 4 + numClasses
  // Anchor 0: cx=320, cy=240, w=20, h=30, cls0=0.95, cls1=0.10 → class 0 wins
  // Anchor 1: cx=100, cy=100, w=10, h=10, cls0=0.10, cls1=0.20 → class 1 wins (above thresh)
  // Anchor 2: cx=  0, cy=  0, w= 1, h= 1, cls0=0.05, cls1=0.05 → below thresh
  const channelsFirst = new Float32Array([
    // attr 0 (cx)
    320, 100, 0,
    // attr 1 (cy)
    240, 100, 0,
    // attr 2 (w)
    20, 10, 1,
    // attr 3 (h)
    30, 10, 1,
    // attr 4 (cls0)
    0.95, 0.1, 0.05,
    // attr 5 (cls1)
    0.1, 0.2, 0.05,
  ])
  const channelsLast = new Float32Array(numAttrs * N)
  for (let i = 0; i < N; i++) {
    for (let a = 0; a < numAttrs; a++) {
      channelsLast[i * numAttrs + a] = channelsFirst[a * N + i]
    }
  }

  it('parses channels-first [1, 4+C, N]', () => {
    const y = new TestableYolo({
      modelPath: 'unused',
      classes: ['player', 'mob'],
      confidenceThreshold: 0.15,
      inputSize: 640,
    })
    const out = { o: fakeTensor([1, numAttrs, N], channelsFirst) }
    const dets = y.parse(out, 640, 640)
    expect(dets.length).toBe(2)
    expect(dets.find((d) => d.class === 'player')!.confidence).toBeCloseTo(0.95, 2)
    expect(dets.find((d) => d.class === 'mob')!.confidence).toBeCloseTo(0.2, 2)
  })

  it('parses channels-last [1, N, 4+C]', () => {
    const y = new TestableYolo({
      modelPath: 'unused',
      classes: ['player', 'mob'],
      confidenceThreshold: 0.15,
      inputSize: 640,
    })
    const out = { o: fakeTensor([1, N, numAttrs], channelsLast) }
    const dets = y.parse(out, 640, 640)
    expect(dets.length).toBe(2)
    expect(dets.find((d) => d.class === 'player')!.confidence).toBeCloseTo(0.95, 2)
  })

  it('throws when configured class count does not match tensor', () => {
    const y = new TestableYolo({
      modelPath: 'unused',
      classes: ['player', 'mob', 'rune', 'portal'], // 4 classes → expects attrs=8
      confidenceThreshold: 0.15,
      inputSize: 640,
    })
    const out = { o: fakeTensor([1, numAttrs, N], channelsFirst) } // 6 attrs
    expect(() => y.parse(out, 640, 640)).toThrow()
  })
})
