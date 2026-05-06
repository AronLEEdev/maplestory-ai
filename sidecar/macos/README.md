# PerceptionSidecar (macOS)

Standalone Swift binary that runs the perception pipeline and emits
detections as NDJSON on stdout. The Node bot core spawns this as a
child process and reads its output.

## Why a sidecar?

Pure-Node options for ScreenCaptureKit + CoreML on Apple Silicon are
limited or polling-based. A native Swift binary using ScreenCaptureKit's
streaming API + CoreML on the Neural Engine reaches 30-60 FPS at 15-20ms
per frame; pure Node tops out around 20-25 FPS at 40-70ms.

The sidecar pattern keeps the Node bot core (calibrator, labeler,
replay, reflex, dsl, runner) untouched. Future Windows support is a
separate sidecar (Rust or C# with DXGI + ONNX-DirectML) emitting the
same NDJSON contract.

## Requirements

- macOS 14+ (Sonoma) — ScreenCaptureKit stable API
- Xcode Command Line Tools (`xcode-select --install`)
- Swift 5.9+ (bundled with Xcode 15+)

## Build

```bash
cd sidecar/macos
swift build -c release
# → .build/release/PerceptionSidecar
```

## Run (standalone, for development)

```bash
.build/release/PerceptionSidecar \
  --model ../../data/models/henesys.mlpackage \
  --game-window 1110,89,1918,1128 \
  --fps 30 \
  --conf 0.5
```

Outputs newline-delimited JSON on stdout, one record per inferred
frame:

```json
{"t":12345,"frameId":7,"tracks":[{"id":1,"class":"mob","bbox":[120,340,55,50],"conf":0.81,"age":12,"vx":-2.1,"vy":0,"hits":11}],"detRaw":7}
```

## Spawn from Node

The bot's `src/perception/sidecar-source.ts` handles spawning + NDJSON
parsing. Sidecar binary is committed to `sidecar/macos/.build/release/`
so users don't need Xcode to run the bot — only contributors building
the sidecar from source do.

## Layout

```
sidecar/macos/
├── Package.swift
├── README.md
└── Sources/PerceptionSidecar/
    ├── main.swift          ← entry point + argv parse
    ├── Capture.swift       ← ScreenCaptureKit stream
    ├── Inference.swift     ← CoreML / Vision Framework
    ├── Tracker.swift       ← Hungarian + Kalman
    └── Output.swift        ← NDJSON emitter
```
