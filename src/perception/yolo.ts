import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import type { Rect } from '@/core/types'
import { CLASS_NAMES, classNameOf } from '@/dataset/yolo-format'
import { logger } from '@/core/logger'

export interface YoloDetection {
  /** "player" or "mob". */
  class: string
  /** Bbox in DISPLAY-space coords (after gameWindow offset is added). */
  bbox: [number, number, number, number]
  confidence: number
}

export interface YoloDetectorOpts {
  /** Path to the .onnx file produced by python/export_onnx.py. */
  modelPath: string
  /** Drop detections with class score below this. Default 0.5. */
  confidenceThreshold?: number
  /** NMS IoU threshold (per-class). Default 0.45. */
  iouThreshold?: number
  /** Square model input size. Must match what was passed to `--imgsz` at export. Default 640. */
  inputSize?: number
}

interface DecodedBox {
  classId: number
  /** Box in INPUT-square coords, before letterbox-undo. */
  cx: number
  cy: number
  w: number
  h: number
  score: number
}

/**
 * YOLOv8 ONNX detector. Loads the model lazily on first detect() so the
 * orchestrator can construct the detector even when no weights exist yet
 * — we only fail when actually running inference.
 *
 * Inference pipeline:
 *   PNG → optional gameWindow crop → letterbox-resize to inputSize²
 *      → CHW float32 [0,1] → onnxruntime → decode (cx,cy,w,h,scores)
 *      → confidence filter → per-class NMS → reverse letterbox + offset
 *
 * Output bboxes are in display-space pixels.
 */
export class YoloDetector {
  private session?: ort.InferenceSession
  private readonly modelPath: string
  private readonly confidenceThreshold: number
  private readonly iouThreshold: number
  private readonly inputSize: number

  constructor(opts: YoloDetectorOpts) {
    this.modelPath = opts.modelPath
    this.confidenceThreshold = opts.confidenceThreshold ?? 0.5
    this.iouThreshold = opts.iouThreshold ?? 0.45
    this.inputSize = opts.inputSize ?? 640
  }

  async load(): Promise<void> {
    if (this.session) return
    const t0 = Date.now()
    this.session = await ort.InferenceSession.create(this.modelPath)
    logger.info(
      {
        modelPath: this.modelPath,
        inputs: this.session.inputNames,
        outputs: this.session.outputNames,
        loadMs: Date.now() - t0,
      },
      'yolo: model loaded',
    )
  }

  /**
   * Run one inference. Returns detections in DISPLAY-space coords.
   * `gameWindow`, when provided, is used to crop the haystack first AND
   * gets added back as an offset to the returned bboxes — so the caller
   * can mix YOLO detections with full-display rectangles (HP/MP regions
   * etc.) in the same coord system.
   */
  async detect(png: Buffer, gameWindow?: Rect): Promise<YoloDetection[]> {
    if (!this.session) await this.load()

    // 1. Crop the source frame to gameWindow if requested. The image used
    //    for inference must match the orientation/scale that the model was
    //    trained on — capture frames were saved game-window-cropped, so
    //    runtime should crop the same way.
    let imgW: number
    let imgH: number
    let imgPipeline = sharp(png)
    if (gameWindow) {
      imgPipeline = imgPipeline.extract({
        left: Math.max(0, Math.round(gameWindow.x)),
        top: Math.max(0, Math.round(gameWindow.y)),
        width: Math.max(1, Math.round(gameWindow.w)),
        height: Math.max(1, Math.round(gameWindow.h)),
      })
      imgW = gameWindow.w
      imgH = gameWindow.h
    } else {
      const meta = await sharp(png).metadata()
      imgW = meta.width ?? 0
      imgH = meta.height ?? 0
    }

    // 2. Letterbox-resize to a square inputSize × inputSize, padding the
    //    short axis with a neutral gray (114) to match Ultralytics defaults.
    const scale = Math.min(this.inputSize / imgW, this.inputSize / imgH)
    const newW = Math.round(imgW * scale)
    const newH = Math.round(imgH * scale)
    const padX = Math.floor((this.inputSize - newW) / 2)
    const padY = Math.floor((this.inputSize - newH) / 2)
    const padRight = this.inputSize - newW - padX
    const padBottom = this.inputSize - newH - padY

    const raw = await imgPipeline
      .resize(newW, newH, { fit: 'fill' })
      .extend({
        top: padY,
        bottom: padBottom,
        left: padX,
        right: padRight,
        background: { r: 114, g: 114, b: 114, alpha: 1 },
      })
      .removeAlpha()
      .raw()
      .toBuffer()

    // 3. HWC uint8 → CHW float32 [0, 1].
    const tensor = hwcToChw(raw, this.inputSize, this.inputSize)

    // 4. Run inference.
    const session = this.session!
    const inputName = session.inputNames[0]
    const outputName = session.outputNames[0]
    const t = new ort.Tensor('float32', tensor, [1, 3, this.inputSize, this.inputSize])
    const t0 = Date.now()
    const out = await session.run({ [inputName]: t })
    const inferMs = Date.now() - t0
    const o = out[outputName]
    if (!o) throw new Error(`yolo: missing output "${outputName}"`)

    // 5. Decode. YOLOv8 channels-first output is [1, 4 + nc, num_anchors].
    const dims = o.dims as readonly number[]
    if (dims.length !== 3 || dims[0] !== 1) {
      throw new Error(`yolo: unexpected output dims ${JSON.stringify(dims)}`)
    }
    const numChannels = dims[1]
    const numAnchors = dims[2]
    const numClasses = numChannels - 4
    if (numClasses !== CLASS_NAMES.length) {
      logger.warn(
        { numClasses, expected: CLASS_NAMES.length },
        'yolo: model class count differs from CLASS_NAMES — class IDs may be wrong',
      )
    }
    const data = o.data as Float32Array
    const decoded: DecodedBox[] = []
    for (let i = 0; i < numAnchors; i++) {
      // Pick the best class for this anchor.
      let bestClass = 0
      let bestScore = data[4 * numAnchors + i]
      for (let c = 1; c < numClasses; c++) {
        const s = data[(4 + c) * numAnchors + i]
        if (s > bestScore) {
          bestScore = s
          bestClass = c
        }
      }
      if (bestScore < this.confidenceThreshold) continue
      decoded.push({
        classId: bestClass,
        cx: data[0 * numAnchors + i],
        cy: data[1 * numAnchors + i],
        w: data[2 * numAnchors + i],
        h: data[3 * numAnchors + i],
        score: bestScore,
      })
    }

    // 6. Per-class NMS.
    const kept = nmsPerClass(decoded, this.iouThreshold)

    // 7. Reverse letterbox + add gameWindow offset → display-space bboxes.
    const offX = gameWindow?.x ?? 0
    const offY = gameWindow?.y ?? 0
    const detections: YoloDetection[] = kept.map((b) => {
      const x0 = (b.cx - b.w / 2 - padX) / scale
      const y0 = (b.cy - b.h / 2 - padY) / scale
      const w = b.w / scale
      const h = b.h / scale
      const className = classNameOf(b.classId) ?? `class_${b.classId}`
      return {
        class: className,
        bbox: [x0 + offX, y0 + offY, w, h],
        confidence: b.score,
      }
    })

    logger.debug({ inferMs, raw: decoded.length, kept: detections.length }, 'yolo: detect done')
    return detections
  }
}

function hwcToChw(hwc: Buffer, w: number, h: number): Float32Array {
  // Source layout: pixel-major rgb rgb rgb ...
  // Target layout: r-plane | g-plane | b-plane.
  const stride = w * h
  const out = new Float32Array(3 * stride)
  for (let i = 0; i < stride; i++) {
    out[0 * stride + i] = hwc[i * 3 + 0] / 255
    out[1 * stride + i] = hwc[i * 3 + 1] / 255
    out[2 * stride + i] = hwc[i * 3 + 2] / 255
  }
  return out
}

function nmsPerClass(boxes: DecodedBox[], iouThresh: number): DecodedBox[] {
  const byClass = new Map<number, DecodedBox[]>()
  for (const b of boxes) {
    const arr = byClass.get(b.classId) ?? []
    arr.push(b)
    byClass.set(b.classId, arr)
  }
  const out: DecodedBox[] = []
  for (const [, arr] of byClass) {
    arr.sort((a, b) => b.score - a.score)
    const kept: DecodedBox[] = []
    for (const b of arr) {
      let drop = false
      for (const k of kept) {
        if (iou(b, k) >= iouThresh) {
          drop = true
          break
        }
      }
      if (!drop) kept.push(b)
    }
    out.push(...kept)
  }
  return out
}

function iou(a: DecodedBox, b: DecodedBox): number {
  const ax1 = a.cx - a.w / 2
  const ay1 = a.cy - a.h / 2
  const ax2 = a.cx + a.w / 2
  const ay2 = a.cy + a.h / 2
  const bx1 = b.cx - b.w / 2
  const by1 = b.cy - b.h / 2
  const bx2 = b.cx + b.w / 2
  const by2 = b.cy + b.h / 2
  const ix1 = Math.max(ax1, bx1)
  const iy1 = Math.max(ay1, by1)
  const ix2 = Math.min(ax2, bx2)
  const iy2 = Math.min(ay2, by2)
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1)
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}
