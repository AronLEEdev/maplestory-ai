// ScreenCaptureKit wrapper. Streams BGRA frames from a display at the
// requested FPS, hands each frame to a callback as a CVPixelBuffer.
//
// Why CVPixelBuffer (not raw Buffer): Vision/CoreML infer paths take
// CVPixelBuffer directly, no copy. We pass it straight through to task
// 4's inference module. Only when emitting debug stats do we touch the
// pixel data.
//
// macOS 14+ required for the stable SCStream API used here.
import Foundation
import ScreenCaptureKit
import CoreVideo
import CoreMedia

enum CaptureError: Error, CustomStringConvertible {
  case noShareableContent
  case noDisplay(Int?)
  case streamSetupFailed(String)
  var description: String {
    switch self {
    case .noShareableContent: return "ScreenCaptureKit returned no shareable content (permission denied?)"
    case .noDisplay(let id): return "no matching display (id=\(String(describing: id)))"
    case .streamSetupFailed(let reason): return "stream setup failed: \(reason)"
    }
  }
}

/// Per-frame callback signature. Implementer should return ASAP — frames
/// arrive on the stream's internal queue, blocking it backpressures capture.
typealias FrameCallback = (CVPixelBuffer, CMTime, Int) -> Void

final class CaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
  private var stream: SCStream?
  private let onFrame: FrameCallback
  private let frameQueue = DispatchQueue(label: "com.maplestory.ai.capture", qos: .userInteractive)
  private var frameCount: Int = 0

  init(onFrame: @escaping FrameCallback) {
    self.onFrame = onFrame
  }

  /// Start streaming the chosen display at fps. Resolves once the stream
  /// is running. Throws on permission denial / config errors.
  func start(displayId: Int? = nil, fps: Int) async throws {
    let content: SCShareableContent
    do {
      content = try await SCShareableContent.excludingDesktopWindows(
        false,
        onScreenWindowsOnly: true
      )
    } catch {
      throw CaptureError.noShareableContent
    }
    let display: SCDisplay
    if let id = displayId {
      guard let d = content.displays.first(where: { Int($0.displayID) == id })
      else { throw CaptureError.noDisplay(id) }
      display = d
    } else {
      guard let d = content.displays.first else { throw CaptureError.noDisplay(nil) }
      display = d
    }

    let filter = SCContentFilter(display: display, excludingWindows: [])

    let config = SCStreamConfiguration()
    // BGRA at native display backing pixels. width/height in points × scale.
    config.width = Int(display.width) * 2  // backing pixels on retina
    config.height = Int(display.height) * 2
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    config.queueDepth = 5
    config.showsCursor = false

    let stream = SCStream(filter: filter, configuration: config, delegate: self)
    do {
      try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: frameQueue)
      try await stream.startCapture()
    } catch {
      throw CaptureError.streamSetupFailed("\(error)")
    }
    self.stream = stream
    FileHandle.standardError.write(
      "capture: started display=\(display.displayID) \(config.width)x\(config.height) fps=\(fps)\n"
        .data(using: .utf8)!
    )
  }

  func stop() async {
    if let s = stream {
      do { try await s.stopCapture() } catch { /* best-effort */ }
    }
    stream = nil
  }

  // MARK: - SCStreamOutput

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen else { return }
    guard sampleBuffer.isValid,
          let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[String: Any]],
          let info = attachments.first,
          let statusRaw = info[SCStreamFrameInfo.status.rawValue] as? Int,
          let status = SCFrameStatus(rawValue: statusRaw),
          status == .complete
    else { return }
    guard let pixelBuffer = sampleBuffer.imageBuffer else { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    onFrame(pixelBuffer, pts, frameCount)
    frameCount += 1
  }

  // MARK: - SCStreamDelegate

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    let nsError = error as NSError
    var msg = "capture: stream stopped with error: \(error)\n"
    // SCStreamErrorDomain code -3805 is the most common symptom of
    // missing TCC permission for the parent process (the terminal that
    // launched us). Surface a hint so users know what to fix.
    if nsError.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain"
        && nsError.code == -3805 {
      msg += """
        hint: this usually means the parent process lacks Screen Recording permission.
              open System Settings → Privacy & Security → Screen Recording,
              add (or re-toggle) the terminal app you launched this from
              (Terminal.app, iTerm, Warp, etc.), then retry.
        """ + "\n"
    }
    FileHandle.standardError.write(msg.data(using: .utf8)!)
    // Stream is dead — exit so the parent (Node bot or shell) sees us gone.
    exit(1)
  }
}
