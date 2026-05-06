// NDJSON emitter. One JSON object per line on stdout, flushed each frame
// so the consumer (Node SidecarSource) can parse incrementally.
//
// Schema (must stay in sync with src/perception/sidecar-source.ts):
//   { "t": <ms since sidecar start>,
//     "frameId": <monotonic int>,
//     "tracks": [ { id, class, bbox: [x,y,w,h], conf, age, vx, vy, hits } ],
//     "detRaw": <int — pre-tracker detection count> }
//
// Box coordinates are in DISPLAY-space pixels (gameWindow offset already
// added back), so the Node bot can render them on a full-screen capture
// without further transform.
import Foundation

struct EmittedTrack: Encodable {
  let id: Int
  let `class`: String
  let bbox: [Double]   // [x, y, w, h]
  let conf: Double
  let age: Int
  let vx: Double
  let vy: Double
  let hits: Int
}

struct EmittedFrame: Encodable {
  let t: Int
  let frameId: Int
  let tracks: [EmittedTrack]
  let detRaw: Int
}

final class NDJSONEmitter {
  private let encoder: JSONEncoder
  private let stdout = FileHandle.standardOutput

  init() {
    let e = JSONEncoder()
    e.outputFormatting = [.withoutEscapingSlashes]
    self.encoder = e
  }

  func emit(_ frame: EmittedFrame) {
    do {
      var data = try encoder.encode(frame)
      data.append(0x0A) // newline
      stdout.write(data)
    } catch {
      FileHandle.standardError.write(
        "ndjson encode failed: \(error)\n".data(using: .utf8)!
      )
    }
  }

  /// Heartbeat record — empty tracks/detRaw=0 — used to verify wiring
  /// before capture/inference are implemented.
  func emitHeartbeat(t: Int, frameId: Int) {
    emit(EmittedFrame(t: t, frameId: frameId, tracks: [], detRaw: 0))
  }
}
