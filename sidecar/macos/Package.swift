// swift-tools-version: 5.9
//
// PerceptionSidecar — Swift binary that handles the perception pipeline
// (ScreenCaptureKit → CoreML → tracker) and emits NDJSON on stdout for
// the Node bot core to consume.
//
// macOS 14+ required for ScreenCaptureKit's stable API.
import PackageDescription

let package = Package(
  name: "PerceptionSidecar",
  platforms: [
    .macOS(.v14),
  ],
  targets: [
    .executableTarget(
      name: "PerceptionSidecar",
      path: "Sources/PerceptionSidecar",
      swiftSettings: [
        .enableUpcomingFeature("BareSlashRegexLiterals"),
      ]
    ),
  ]
)
