// --capture-only mode: spin up SCStream, measure FPS + per-frame ms,
// log to stderr every 1s. No NDJSON output (task 8 wires that). Used to
// verify ScreenCaptureKit works on this machine before model + tracker
// are integrated.
//
// SIGINT/SIGTERM stops cleanly via DispatchSource handlers in main.swift.
import Foundation
import CoreVideo

// SCStream needs a long-lived strong reference. Keeping it in a Task closure
// scope drops it the moment startCapture() resolves, killing the stream
// with -3805 ("application connection broken"). Module-scope holder fixes it.
private var capturedSession: CaptureSession?

func runCaptureOnlyMode(parsed: Args) {
  let startedAt = Date()
  var lastReportAt = startedAt
  var framesSinceReport = 0
  var msSinceReport: [Double] = []
  msSinceReport.reserveCapacity(120)
  var lastFrameAt = Date()

  let session = CaptureSession { _, _, frameId in
    let now = Date()
    let dt = now.timeIntervalSince(lastFrameAt) * 1000
    lastFrameAt = now
    if frameId > 0 { msSinceReport.append(dt) }
    framesSinceReport += 1

    if now.timeIntervalSince(lastReportAt) >= 1.0 {
      let elapsed = now.timeIntervalSince(lastReportAt)
      let fps = Double(framesSinceReport) / elapsed
      msSinceReport.sort()
      let n = msSinceReport.count
      let p50 = n > 0 ? msSinceReport[n / 2] : 0
      let p95 = n > 0 ? msSinceReport[min(n - 1, Int(Double(n) * 0.95))] : 0
      let total = Int(now.timeIntervalSince(startedAt))
      FileHandle.standardError.write(
        String(
          format: "capture: t=%ds fps=%.1f frame-interval p50=%.1fms p95=%.1fms\n",
          total, fps, p50, p95
        ).data(using: .utf8)!
      )
      lastReportAt = now
      framesSinceReport = 0
      msSinceReport.removeAll(keepingCapacity: true)
    }
  }

  capturedSession = session
  Task {
    do {
      try await session.start(displayId: parsed.displayId, fps: parsed.fps)
    } catch {
      FileHandle.standardError.write("capture-only: \(error)\n".data(using: .utf8)!)
      exit(1)
    }
  }
}
