import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { YoloPerception } from '@/perception/yolo'

const MODEL = 'models/yolov8n-maplestory.onnx'

describe.skipIf(!existsSync(MODEL))('YoloPerception integration', () => {
  it('loads ONNX model', async () => {
    const y = new YoloPerception({
      modelPath: MODEL,
      classes: ['player', 'mob_generic', 'rune', 'portal'],
    })
    await y.load()
    expect(true).toBe(true)
  })
})
