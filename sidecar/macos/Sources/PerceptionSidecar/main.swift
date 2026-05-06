// PerceptionSidecar — entry point.
// Task 1 (scaffold): minimal binary that compiles, prints version on stderr,
// exits clean. Task 2 will add argv parsing + NDJSON heartbeat.
import Foundation

let version = "0.1.0-scaffold"

FileHandle.standardError.write("PerceptionSidecar \(version) — scaffold build, no-op\n".data(using: .utf8)!)
exit(0)
