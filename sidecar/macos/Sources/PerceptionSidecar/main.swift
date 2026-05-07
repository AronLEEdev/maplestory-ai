// PerceptionSidecar — entry point.
//
// Task 2: argv parsing + NDJSON heartbeat loop.
// Capture (task 3), inference (4), tracker (7) layered on subsequent commits.
import Foundation

let version = "0.1.0"

let parsed: Args
do {
  parsed = try parseArgs(CommandLine.arguments)
} catch {
  FileHandle.standardError.write("error: \(error)\n".data(using: .utf8)!)
  printUsage()
  exit(2)
}

FileHandle.standardError.write(
  "PerceptionSidecar \(version) — fps=\(parsed.fps) heartbeat-only=\(parsed.heartbeatOnly) capture-only=\(parsed.captureOnly) inference-test=\(parsed.inferenceTest)\n"
    .data(using: .utf8)!
)

if parsed.inferenceTest {
  runInferenceTestMode(parsed: parsed)
  // runInferenceTestMode exits internally; never returns.
}

if parsed.captureOnly {
  runCaptureOnlyMode(parsed: parsed)
  dispatchMain()
}

if !parsed.heartbeatOnly && !parsed.captureOnly && !parsed.inferenceTest {
  // Real mode (capture + inference + tracker) lands in task 8. Until then
  // require one of the test-mode flags.
  FileHandle.standardError.write(
    "error: real-mode pipeline not implemented yet (task 8). Run with --heartbeat-only, --capture-only, or --inference-test for now.\n"
      .data(using: .utf8)!
  )
  exit(1)
}

// Heartbeat loop: emit one empty frame per period until SIGINT/SIGTERM.
let emitter = NDJSONEmitter()
let startedAt = Date()
let periodNs = UInt64(1_000_000_000 / parsed.fps)
var frameId = 0

// Trap SIGINT/SIGTERM for clean shutdown so the Node parent can stop us
// without leaving stale stdout buffers.
let sigintSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let sigtermSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let stopHandler = {
  FileHandle.standardError.write("PerceptionSidecar: stopping\n".data(using: .utf8)!)
  exit(0)
}
sigintSrc.setEventHandler(handler: stopHandler)
sigtermSrc.setEventHandler(handler: stopHandler)
sigintSrc.resume()
sigtermSrc.resume()

let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now(), repeating: .nanoseconds(Int(periodNs)))
timer.setEventHandler {
  let elapsedMs = Int(Date().timeIntervalSince(startedAt) * 1000)
  emitter.emitHeartbeat(t: elapsedMs, frameId: frameId)
  frameId += 1
}
timer.resume()

dispatchMain()
