// --preprocess-test: spin up SCK capture, run preprocess on every frame
// for N frames, log per-frame ms stats, exit. Validates BGRA → 640×640
// letterbox runs at the budget we need (target <3ms per frame).
import Foundation
import CoreVideo

private var preprocSession: CaptureSession?

func runPreprocessTestMode(parsed: Args) {
  guard let gw = parsed.gameWindow else {
    FileHandle.standardError.write("preprocess-test: --game-window required\n".data(using: .utf8)!)
    exit(2)
  }
  let total = max(parsed.inferenceTestIters, 30)
  let warmup = min(5, total / 4)

  let pre = Preprocessor(inputSize: 640, gameWindow: gw)
  let lb = pre.letterboxRect
  FileHandle.standardError.write(
    String(
      format: "preprocess-test: gameWindow=%d,%d,%d,%d → 640×640 (scale=%.4f padX=%d padY=%d)\n",
      gw.x, gw.y, gw.w, gw.h, lb.scale, lb.padX, lb.padY
    ).data(using: .utf8)!
  )

  var ms: [Double] = []
  ms.reserveCapacity(total)
  var processed = 0
  var done = false
  let lock = NSLock()

  let session = CaptureSession { src, _, _ in
    lock.lock()
    defer { lock.unlock() }
    if done { return }
    let t0 = Date()
    _ = pre.preprocess(src)
    let dt = Date().timeIntervalSince(t0) * 1000
    if processed >= warmup {
      ms.append(dt)
    }
    processed += 1
    if ms.count >= total - warmup {
      done = true
      DispatchQueue.main.async { reportAndExit(ms: ms) }
    }
  }
  preprocSession = session
  Task {
    do {
      try await session.start(displayId: parsed.displayId, fps: parsed.fps)
    } catch {
      FileHandle.standardError.write("preprocess-test: \(error)\n".data(using: .utf8)!)
      exit(1)
    }
  }
}

private func reportAndExit(ms: [Double]) {
  var sorted = ms
  sorted.sort()
  let n = sorted.count
  let avg = sorted.reduce(0, +) / Double(n)
  let p50 = sorted[n / 2]
  let p95 = sorted[min(n - 1, Int(Double(n) * 0.95))]
  let p99 = sorted[min(n - 1, Int(Double(n) * 0.99))]
  FileHandle.standardError.write(
    String(
      format: """
        preprocess-test: %d iters
          avg=%.2fms p50=%.2fms p95=%.2fms p99=%.2fms
        """,
      n, avg, p50, p95, p99
    ).data(using: .utf8)! + "\n".data(using: .utf8)!
  )
  exit(0)
}
