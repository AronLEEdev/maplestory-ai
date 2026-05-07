// Real mode: continuous perception pipeline.
//
//   SCK frame  →  preprocess (BGRA → 640×640 letterbox)
//              →  CoreML infer (Neural Engine)
//              →  postprocess (decode + NMS, display-space coords)
//              →  tracker (stable IDs + velocity)
//              →  NDJSON on stdout
//
// All work happens on SCK's frame-handler queue. With our budget
// (~6ms total per frame at 30 FPS = 33ms cadence), no need to split
// across queues — SCK backpressures naturally if the pipeline lags.
import Foundation
import CoreML
import CoreVideo

private var realCaptureSession: CaptureSession?

func runRealMode(parsed: Args) {
  guard let modelPath = parsed.modelPath else {
    FileHandle.standardError.write("real-mode: --model required\n".data(using: .utf8)!)
    exit(2)
  }
  guard let gw = parsed.gameWindow else {
    FileHandle.standardError.write("real-mode: --game-window required\n".data(using: .utf8)!)
    exit(2)
  }

  let infer: Inference
  do {
    infer = try Inference(modelPath: modelPath)
  } catch {
    FileHandle.standardError.write("real-mode: \(error)\n".data(using: .utf8)!)
    exit(1)
  }

  let pre = Preprocessor(inputSize: 640, gameWindow: gw)
  let post = Postprocess(confidenceThreshold: parsed.confidence, iouPerClass: 0.45, iouCrossClass: 0.5)
  let tracker = Tracker()
  let emitter = NDJSONEmitter()
  let inputName = infer.schema.inputName

  FileHandle.standardError.write(
    String(
      format: "real-mode: ready — gameWindow=%d,%d,%d,%d conf=%.2f model=%@\n",
      gw.x, gw.y, gw.w, gw.h, parsed.confidence, (modelPath as NSString).lastPathComponent
    ).data(using: .utf8)!
  )

  let startedAt = Date()
  // Per-frame stats reported on stderr every 1s for observability. Sidecar
  // is otherwise silent — stdout is reserved for NDJSON.
  var lastStatsAt = startedAt
  var framesSinceStats = 0
  var msSinceStats: [Double] = []
  var rawDetSinceStats = 0
  var trackSinceStats = 0

  let session = CaptureSession { src, _, frameId in
    let t0 = Date()
    // 1. Preprocess.
    guard let lbBuffer = pre.preprocess(src) else {
      FileHandle.standardError.write("real-mode: preprocess returned nil at frame \(frameId)\n".data(using: .utf8)!)
      return
    }
    // 2. Infer.
    let provider: MLFeatureProvider
    do {
      provider = try MLDictionaryFeatureProvider(dictionary: [
        inputName: MLFeatureValue(pixelBuffer: lbBuffer)
      ])
    } catch {
      FileHandle.standardError.write("real-mode: feature provider build failed: \(error)\n".data(using: .utf8)!)
      return
    }
    let outProvider: MLFeatureProvider
    do {
      outProvider = try infer.predict(provider)
    } catch {
      FileHandle.standardError.write("real-mode: predict failed: \(error)\n".data(using: .utf8)!)
      return
    }
    guard let outArray = outProvider.featureValue(for: infer.schema.outputName)?.multiArrayValue else {
      FileHandle.standardError.write("real-mode: missing output multiArray\n".data(using: .utf8)!)
      return
    }
    // 3. Postprocess (decode + NMS).
    let dets: [RawDetection]
    do {
      dets = try post.decode(outArray, lb: pre.letterboxRect)
    } catch {
      FileHandle.standardError.write("real-mode: decode failed: \(error)\n".data(using: .utf8)!)
      return
    }
    // 4. Tracker.
    let tracks = tracker.step(detections: dets)

    // 5. Emit NDJSON on stdout.
    let elapsedMs = Int(Date().timeIntervalSince(startedAt) * 1000)
    let emitted = tracks.map { t in
      EmittedTrack(
        id: t.id,
        class: className(forId: t.classId),
        bbox: [
          Double(t.bbox.x), Double(t.bbox.y),
          Double(t.bbox.w), Double(t.bbox.h),
        ],
        conf: Double(t.conf),
        age: t.age,
        vx: Double(t.vx),
        vy: Double(t.vy),
        hits: t.hits
      )
    }
    emitter.emit(EmittedFrame(t: elapsedMs, frameId: frameId, tracks: emitted, detRaw: dets.count))

    // 6. Stats.
    let dt = Date().timeIntervalSince(t0) * 1000
    msSinceStats.append(dt)
    framesSinceStats += 1
    rawDetSinceStats += dets.count
    trackSinceStats += tracks.count
    let now = Date()
    if now.timeIntervalSince(lastStatsAt) >= 1.0 {
      msSinceStats.sort()
      let n = msSinceStats.count
      let p50 = n > 0 ? msSinceStats[n / 2] : 0
      let p95 = n > 0 ? msSinceStats[min(n - 1, Int(Double(n) * 0.95))] : 0
      let elapsed = now.timeIntervalSince(lastStatsAt)
      let fps = Double(framesSinceStats) / elapsed
      let avgRawDet = Double(rawDetSinceStats) / Double(framesSinceStats)
      let avgTracks = Double(trackSinceStats) / Double(framesSinceStats)
      FileHandle.standardError.write(
        String(
          format: "real-mode: fps=%.1f pipeline p50=%.1fms p95=%.1fms detRaw=%.1f/frame tracks=%.1f/frame\n",
          fps, p50, p95, avgRawDet, avgTracks
        ).data(using: .utf8)!
      )
      lastStatsAt = now
      framesSinceStats = 0
      msSinceStats.removeAll(keepingCapacity: true)
      rawDetSinceStats = 0
      trackSinceStats = 0
    }
  }
  realCaptureSession = session

  Task {
    do {
      try await session.start(displayId: parsed.displayId, fps: parsed.fps)
    } catch {
      FileHandle.standardError.write("real-mode: capture start failed: \(error)\n".data(using: .utf8)!)
      exit(1)
    }
  }
}
