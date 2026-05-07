// YOLOv8 output decode + NMS. Mirrors src/perception/yolo.ts so the
// sidecar produces detections in the same coordinate system the Node
// bot already understands.
//
// Input: MLMultiArray shape [1, 4 + numClasses, numAnchors] (e.g.
//        [1, 6, 8400] for 2-class YOLOv8n at 640×640).
// Output: [Detection] in DISPLAY-space coordinates (gameWindow offset
//         already added back via LetterboxRect).
import Foundation
import CoreML

/// One mob/player detection in display-space coords.
struct RawDetection {
  let classId: Int
  let score: Float
  /// Bounding box [x, y, w, h] in display-space pixels.
  let bbox: (x: Float, y: Float, w: Float, h: Float)
}

enum PostprocessError: Error, CustomStringConvertible {
  case unexpectedShape([NSNumber])
  case unsupportedDataType
  var description: String {
    switch self {
    case .unexpectedShape(let s): return "expected output shape [1, 4+nc, anchors], got \(s)"
    case .unsupportedDataType: return "unsupported MLMultiArray dataType"
    }
  }
}

final class Postprocess {
  let confidenceThreshold: Float
  let iouPerClass: Float
  let iouCrossClass: Float
  let inputSize: Int

  init(confidenceThreshold: Double, iouPerClass: Double = 0.45, iouCrossClass: Double = 0.5, inputSize: Int = 640) {
    self.confidenceThreshold = Float(confidenceThreshold)
    self.iouPerClass = Float(iouPerClass)
    self.iouCrossClass = Float(iouCrossClass)
    self.inputSize = inputSize
  }

  /// Decode the model output and emit detections in display space.
  func decode(_ output: MLMultiArray, lb: LetterboxRect) throws -> [RawDetection] {
    // Expect [1, channels, anchors].
    guard output.shape.count == 3, output.shape[0].intValue == 1 else {
      throw PostprocessError.unexpectedShape(output.shape)
    }
    let channels = output.shape[1].intValue
    let anchors = output.shape[2].intValue
    let numClasses = channels - 4
    guard numClasses >= 1, numClasses <= 80 else {
      throw PostprocessError.unexpectedShape(output.shape)
    }
    guard output.dataType == .float32 else {
      throw PostprocessError.unsupportedDataType
    }

    // MLMultiArray.dataPointer is a typeless raw pointer. Bind to Float for
    // direct stride math — mirrors `arr[c * anchors + i]` index used in
    // src/perception/yolo.ts.
    let basePtr = output.dataPointer.bindMemory(to: Float.self, capacity: channels * anchors)
    let conf = self.confidenceThreshold
    let invScale = Float(1.0 / lb.scale)
    let padX = Float(lb.padX)
    let padY = Float(lb.padY)
    let cropX = Float(lb.cropOriginX)
    let cropY = Float(lb.cropOriginY)

    var dets: [RawDetection] = []
    dets.reserveCapacity(64)
    for i in 0..<anchors {
      // Pick best class.
      var bestClass = 0
      var bestScore = basePtr[4 * anchors + i]
      for c in 1..<numClasses {
        let s = basePtr[(4 + c) * anchors + i]
        if s > bestScore {
          bestScore = s
          bestClass = c
        }
      }
      if bestScore < conf { continue }
      // Box in 640×640 input coords.
      let cx = basePtr[0 * anchors + i]
      let cy = basePtr[1 * anchors + i]
      let w = basePtr[2 * anchors + i]
      let h = basePtr[3 * anchors + i]
      // Reverse letterbox: subtract pad, divide by scale, then add the
      // gameWindow crop origin to land in display space.
      let x0_input = cx - w / 2
      let y0_input = cy - h / 2
      let x = (x0_input - padX) * invScale + cropX
      let y = (y0_input - padY) * invScale + cropY
      let outW = w * invScale
      let outH = h * invScale
      dets.append(RawDetection(classId: bestClass, score: bestScore, bbox: (x, y, outW, outH)))
    }

    // Per-class NMS first, then class-agnostic NMS — same order as
    // src/perception/yolo.ts so behavior matches Node.
    let perClassKept = nmsPerClass(dets, iouThresh: iouPerClass)
    return nmsAgnostic(perClassKept, iouThresh: iouCrossClass)
  }

  // MARK: - NMS

  private func nmsPerClass(_ boxes: [RawDetection], iouThresh: Float) -> [RawDetection] {
    var byClass: [Int: [RawDetection]] = [:]
    for b in boxes {
      byClass[b.classId, default: []].append(b)
    }
    var out: [RawDetection] = []
    for (_, var arr) in byClass {
      arr.sort { $0.score > $1.score }
      var kept: [RawDetection] = []
      for b in arr {
        var drop = false
        for k in kept where iou(b.bbox, k.bbox) >= iouThresh {
          drop = true
          break
        }
        if !drop { kept.append(b) }
      }
      out.append(contentsOf: kept)
    }
    return out
  }

  private func nmsAgnostic(_ boxes: [RawDetection], iouThresh: Float) -> [RawDetection] {
    let sorted = boxes.sorted { $0.score > $1.score }
    var kept: [RawDetection] = []
    for b in sorted {
      var drop = false
      for k in kept where iou(b.bbox, k.bbox) >= iouThresh {
        drop = true
        break
      }
      if !drop { kept.append(b) }
    }
    return kept
  }

  private func iou(_ a: (x: Float, y: Float, w: Float, h: Float), _ b: (x: Float, y: Float, w: Float, h: Float)) -> Float {
    let ax2 = a.x + a.w, ay2 = a.y + a.h
    let bx2 = b.x + b.w, by2 = b.y + b.h
    let ix1 = max(a.x, b.x), iy1 = max(a.y, b.y)
    let ix2 = min(ax2, bx2), iy2 = min(ay2, by2)
    let inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    let union = a.w * a.h + b.w * b.h - inter
    return union > 0 ? inter / union : 0
  }
}

/// Class id → name. Matches src/dataset/yolo-format.ts CLASS_NAMES.
/// Update both sides together when v2.3 (one-class) lands.
let CLASS_NAMES: [String] = ["player", "mob"]

func className(forId id: Int) -> String {
  if id >= 0 && id < CLASS_NAMES.count { return CLASS_NAMES[id] }
  return "class_\(id)"
}
