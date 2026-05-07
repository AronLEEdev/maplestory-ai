// BGRA capture frame → 640×640 letterboxed CVPixelBuffer for CoreML.
//
// Pipeline:
//   1. Crop incoming CVPixelBuffer to gameWindow rect (display-space px).
//   2. Resize cropped region to fit inside 640×640 keeping aspect ratio.
//   3. Composite onto a 114-gray 640×640 canvas (Ultralytics letterbox
//      convention — gray, not black).
//   4. Render into a pooled BGRA CVPixelBuffer that the model accepts.
//
// CIImage handles steps 1-4 on the GPU. Output goes through a
// CVPixelBufferPool so we don't allocate per-frame buffers (allocations
// would dominate over the actual ~1.5ms inference).
//
// LetterboxRect remembers the scale factor + offsets so postprocess
// (task 6) can reverse the coordinates back to display space.
import Foundation
import CoreImage
import CoreVideo
import Accelerate

struct LetterboxRect {
  let scale: Double      // input_px → 640px ratio (≤1.0 always)
  let padX: Int          // pixels of gray on the left of the resized region
  let padY: Int
  let cropOriginX: Int   // gameWindow.x — added back during postprocess
  let cropOriginY: Int   // gameWindow.y
}

final class Preprocessor {
  private let inputSize: Int
  private let gameWindow: (x: Int, y: Int, w: Int, h: Int)
  private let ciContext: CIContext
  private var bufferPool: CVPixelBufferPool?
  private let grayBackground: CIImage  // 114-gray opaque

  init(inputSize: Int = 640, gameWindow: (x: Int, y: Int, w: Int, h: Int)) {
    self.inputSize = inputSize
    self.gameWindow = gameWindow
    // useSoftwareRenderer=false → Metal-backed; ~3-5x faster on M4.
    self.ciContext = CIContext(options: [.useSoftwareRenderer: false])
    let g = CGFloat(114) / 255
    self.grayBackground = CIImage(color: CIColor(red: g, green: g, blue: g, alpha: 1))
      .cropped(to: CGRect(x: 0, y: 0, width: inputSize, height: inputSize))
  }

  /// Where the cropped+scaled region sits inside the 640×640 letterbox.
  /// Postprocess (task 6) reverses these to map model output coords back
  /// to display-space pixels.
  var letterboxRect: LetterboxRect {
    let gw = gameWindow
    let s = min(Double(inputSize) / Double(gw.w), Double(inputSize) / Double(gw.h))
    let scaledW = Int((Double(gw.w) * s).rounded())
    let scaledH = Int((Double(gw.h) * s).rounded())
    return LetterboxRect(
      scale: s,
      padX: (inputSize - scaledW) / 2,
      padY: (inputSize - scaledH) / 2,
      cropOriginX: gw.x,
      cropOriginY: gw.y
    )
  }

  /// Process one frame. Returns a 640×640 BGRA CVPixelBuffer the CoreML
  /// model can consume. Buffer comes from a pool — caller MUST NOT retain
  /// it past the next call (the pool may reuse it).
  func preprocess(_ src: CVPixelBuffer) -> CVPixelBuffer? {
    let lb = letterboxRect
    let srcH = CVPixelBufferGetHeight(src)

    // Build the CIImage and crop to gameWindow. CIImage uses lower-left
    // origin; SCK pixel buffer follows top-left, so flip cropY.
    let ci = CIImage(cvPixelBuffer: src)
    let cropY_LL = srcH - gameWindow.y - gameWindow.h
    let cropRect = CGRect(
      x: gameWindow.x,
      y: cropY_LL,
      width: gameWindow.w,
      height: gameWindow.h
    )
    var img = ci.cropped(to: cropRect)
    // After .cropped() the image keeps its original origin; translate so
    // the crop's lower-left lands at (0, 0).
    img = img.transformed(by: CGAffineTransform(translationX: -cropRect.minX, y: -cropRect.minY))

    // Scale by `scale` factor, then translate to leave letterbox padding.
    img = img.transformed(by: CGAffineTransform(scaleX: lb.scale, y: lb.scale))
    let scaledH = Int((Double(gameWindow.h) * lb.scale).rounded())
    let topPad_LL = inputSize - lb.padY - scaledH
    img = img.transformed(by: CGAffineTransform(translationX: CGFloat(lb.padX), y: CGFloat(topPad_LL)))

    // Composite over the gray 640×640 canvas.
    let composed = img.composited(over: grayBackground)

    // Render to a pooled BGRA buffer.
    let pool = ensurePool()
    var dst: CVPixelBuffer?
    let st = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &dst)
    guard st == kCVReturnSuccess, let out = dst else { return nil }
    ciContext.render(
      composed,
      to: out,
      bounds: CGRect(x: 0, y: 0, width: inputSize, height: inputSize),
      colorSpace: CGColorSpaceCreateDeviceRGB()
    )
    return out
  }

  // MARK: - Pool

  private func ensurePool() -> CVPixelBufferPool {
    if let p = bufferPool { return p }
    let attrs: [String: Any] = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: inputSize,
      kCVPixelBufferHeightKey as String: inputSize,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:],
    ]
    var pool: CVPixelBufferPool?
    CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &pool)
    bufferPool = pool!
    return pool!
  }
}
