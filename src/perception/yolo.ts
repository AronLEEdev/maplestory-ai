import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import { nonMaxSuppression } from './nms'
import type { Detection, PerceptionFrame } from '@/core/types'

export interface YoloOpts {
  modelPath: string
  inputSize?: number
  confidenceThreshold?: number
  classes: string[]
}

export class YoloPerception {
  private session: ort.InferenceSession | null = null
  private opts: {
    modelPath: string
    inputSize: number
    confidenceThreshold: number
    classes: string[]
  }

  constructor(opts: YoloOpts) {
    this.opts = {
      modelPath: opts.modelPath,
      inputSize: opts.inputSize ?? 640,
      confidenceThreshold: opts.confidenceThreshold ?? 0.6,
      classes: opts.classes,
    }
  }

  async load(): Promise<void> {
    this.session = await ort.InferenceSession.create(this.opts.modelPath)
  }

  async run(rawScreenshot: Buffer, screenW: number, screenH: number): Promise<PerceptionFrame> {
    if (!this.session) throw new Error('YoloPerception: load() not called')
    const sz = this.opts.inputSize
    const resized = await sharp(rawScreenshot, {
      raw: { width: screenW, height: screenH, channels: 4 },
    })
      .removeAlpha()
      .resize(sz, sz, { fit: 'fill' })
      .raw()
      .toBuffer()
    const chw = new Float32Array(3 * sz * sz)
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        const i = (y * sz + x) * 3
        chw[0 * sz * sz + y * sz + x] = resized[i + 0] / 255
        chw[1 * sz * sz + y * sz + x] = resized[i + 1] / 255
        chw[2 * sz * sz + y * sz + x] = resized[i + 2] / 255
      }
    }
    const tensor = new ort.Tensor('float32', chw, [1, 3, sz, sz])
    const inputName = this.session.inputNames[0]
    const out = await this.session.run({ [inputName]: tensor })
    const detections = this.parseYoloOutput(out, screenW, screenH)
    return {
      timestamp: Date.now(),
      detections: nonMaxSuppression(detections, 0.5),
      screenshotMeta: { width: screenW, height: screenH },
      overallConfidence: detections.reduce((m, d) => Math.max(m, d.confidence), 0),
    }
  }

  private parseYoloOutput(
    out: ort.InferenceSession.OnnxValueMapType,
    screenW: number,
    screenH: number,
  ): Detection[] {
    const tensor = out[Object.keys(out)[0]] as ort.Tensor
    const data = tensor.data as Float32Array
    const dims = tensor.dims
    if (dims.length !== 3 || dims[0] !== 1) {
      throw new Error(`YOLO output unexpected shape: ${dims.join('x')}`)
    }
    // Autodetect channels-first [1, 4+C, N] vs channels-last [1, N, 4+C].
    // 4+C is always small (4 + numClasses), N is anchors (typically 8400 for 640).
    const expectedAttrs = 4 + this.opts.classes.length
    let numAttrs: number
    let N: number
    let channelsFirst: boolean
    if (dims[1] === expectedAttrs) {
      channelsFirst = true
      numAttrs = dims[1]
      N = dims[2]
    } else if (dims[2] === expectedAttrs) {
      channelsFirst = false
      numAttrs = dims[2]
      N = dims[1]
    } else {
      // Fallback: pick the smaller axis as attrs (works when classes count is unknown).
      channelsFirst = dims[1] < dims[2]
      numAttrs = channelsFirst ? dims[1] : dims[2]
      N = channelsFirst ? dims[2] : dims[1]
      if (numAttrs - 4 !== this.opts.classes.length) {
        throw new Error(
          `YOLO output attrs=${numAttrs} but configured for ${this.opts.classes.length} classes (expected ${expectedAttrs})`,
        )
      }
    }
    const numClasses = numAttrs - 4
    const at = channelsFirst
      ? (attr: number, i: number) => data[attr * N + i]
      : (attr: number, i: number) => data[i * numAttrs + attr]
    const sz = this.opts.inputSize
    const sx = screenW / sz,
      sy = screenH / sz
    const dets: Detection[] = []
    for (let i = 0; i < N; i++) {
      const cx = at(0, i),
        cy = at(1, i),
        w = at(2, i),
        h = at(3, i)
      let bestC = -1,
        bestP = 0
      for (let c = 0; c < numClasses; c++) {
        const p = at(4 + c, i)
        if (p > bestP) {
          bestP = p
          bestC = c
        }
      }
      if (bestP < this.opts.confidenceThreshold) continue
      const x = (cx - w / 2) * sx,
        y = (cy - h / 2) * sy
      dets.push({
        class: this.opts.classes[bestC] ?? `class_${bestC}`,
        bbox: [x, y, w * sx, h * sy],
        confidence: bestP,
      })
    }
    return dets
  }
}
