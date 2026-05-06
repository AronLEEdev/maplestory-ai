// CLI argument parsing for the perception sidecar.
//
// Format (long flags only, simple to parse manually so we don't pull in
// argument-parser as a dep):
//   --model <path>          path to the .mlpackage (required)
//   --game-window x,y,w,h   crop rect inside captured display (required)
//   --fps <n>               target frames-per-second (default 30)
//   --conf <0..1>           confidence threshold (default 0.5)
//   --iou <0..1>            NMS IoU threshold (default 0.45)
//   --display <id>          monitor id (default primary)
//   --heartbeat-only        skip capture/inference, emit empty frames
//                           on stdout — used to verify wiring before
//                           ScreenCaptureKit / CoreML are ready.
//
// Errors written to stderr; exit 2 on bad args. exit 1 reserved for
// runtime errors (capture lost, model load failed, etc.).
import Foundation

struct Args {
  var modelPath: String?
  var gameWindow: (x: Int, y: Int, w: Int, h: Int)?
  var fps: Int = 30
  var confidence: Double = 0.5
  var iou: Double = 0.45
  var displayId: Int?
  var heartbeatOnly: Bool = false
}

enum ArgsError: Error, CustomStringConvertible {
  case missing(String)
  case invalid(String, String)
  var description: String {
    switch self {
    case .missing(let f): return "missing required arg: \(f)"
    case .invalid(let f, let v): return "invalid value for \(f): \(v)"
    }
  }
}

func parseArgs(_ argv: [String]) throws -> Args {
  var out = Args()
  var i = 1
  while i < argv.count {
    let flag = argv[i]
    switch flag {
    case "--model":
      i += 1
      out.modelPath = argv[i]
    case "--game-window":
      i += 1
      let parts = argv[i].split(separator: ",").compactMap { Int($0) }
      guard parts.count == 4 else { throw ArgsError.invalid("--game-window", argv[i]) }
      out.gameWindow = (parts[0], parts[1], parts[2], parts[3])
    case "--fps":
      i += 1
      guard let n = Int(argv[i]), n > 0 && n <= 120 else {
        throw ArgsError.invalid("--fps", argv[i])
      }
      out.fps = n
    case "--conf":
      i += 1
      guard let v = Double(argv[i]), v >= 0 && v <= 1 else {
        throw ArgsError.invalid("--conf", argv[i])
      }
      out.confidence = v
    case "--iou":
      i += 1
      guard let v = Double(argv[i]), v >= 0 && v <= 1 else {
        throw ArgsError.invalid("--iou", argv[i])
      }
      out.iou = v
    case "--display":
      i += 1
      guard let n = Int(argv[i]) else { throw ArgsError.invalid("--display", argv[i]) }
      out.displayId = n
    case "--heartbeat-only":
      out.heartbeatOnly = true
    case "-h", "--help":
      printUsage()
      exit(0)
    default:
      throw ArgsError.invalid("flag", flag)
    }
    i += 1
  }
  // heartbeat-only mode skips required-arg checks so wiring tests are easy.
  if out.heartbeatOnly { return out }
  if out.modelPath == nil { throw ArgsError.missing("--model") }
  if out.gameWindow == nil { throw ArgsError.missing("--game-window") }
  return out
}

func printUsage() {
  let usage = """
    PerceptionSidecar — perception pipeline for maplestory.ai

    Usage:
      PerceptionSidecar --model <path> --game-window x,y,w,h \\
        [--fps 30] [--conf 0.5] [--iou 0.45] [--display <id>]
      PerceptionSidecar --heartbeat-only [--fps 10]

    Emits NDJSON on stdout, one record per inferred frame:
      {"t":12345,"frameId":7,"tracks":[...],"detRaw":N}

    """
  FileHandle.standardError.write(usage.data(using: .utf8)!)
}
