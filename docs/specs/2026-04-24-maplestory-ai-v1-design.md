# maplestory.ai — v1 Design Spec

**Date:** 2026-04-24
**Status:** Draft
**Owner:** aronleedev@gmail.com
**Relationship to Faker.ai:** maplestory.ai is an independent v1 project focused on **Maplestory only**. Faker.ai is a separate, later-stage, platform-level effort. Code in this repo does **not** aim for game-agnostic abstractions — we pick the simplest path that works for Maplestory and ship.

---

## 1. Overview

maplestory.ai is a desktop tool that learns a user's farming behavior from a short demonstration, then repeats it on-demand. The user records themselves farming a map for 2–3 cycles; an offline LLM analyzer summarizes the recording into a structured routine YAML; the runtime perceives the live game via YOLO and pixel sampling and executes the routine until the user stops it.

### 1.1 Goals

- Reliable unsupervised farming on flat-platform Maplestory maps (30+ minute sessions).
- Record-and-derive routine authoring — user never hand-writes YAML.
- Cross-platform runtime (Windows primary, Mac secondary).
- Local-first execution: no cloud calls during play. Cloud LLM is used only during the one-shot offline `analyze` step.
- Safe by default: focus-gated input, kill-switch hotkeys, dry-run and safe-mode before live.

### 1.2 Non-goals (v1)

- Other games, adapter abstractions, generic game support → that is Faker.ai.
- Rune-solving (scaffolded, deferred to v1.1).
- Background / unfocused input injection (design holds a seam for it — v2).
- In-process local VLM (Moondream/Florence). Cloud LLM for offline analysis only.
- Web monitoring dashboard.
- Anti-detection / anti-cheat evasion. Users accept ToS risk.
- Boss runs, party play, PvP, multi-map routing.
- Visual region-drawing calibration wizard — auto-calibration from recording replaces it.

---

## 2. Architecture

Five runtime modules plus two offline modules. Loose coupling via a typed event bus and a central `ActionScheduler` that arbitrates between all input producers.

### 2.1 Runtime modules

```
┌─────────────────────────── Orchestrator ───────────────────────────┐
│  Loads routine.yaml, wires modules, owns run loop, CLI entrypoint │
└────────────────────────────────────────────────────────────────────┘
       │                        │                       │
┌──────▼──────┐         ┌───────▼────────┐     ┌────────▼────────┐
│ Capture     │         │ Perception     │     │ Reflex          │
│ Provider    │────────►│  YOLO + NMS    │     │  pixel sampling │
│ (swappable) │         │  emits Frame   │     │  @ 60 Hz        │
└─────────────┘         └───────┬────────┘     └────────┬────────┘
                                │                       │
                                ▼                       │
                        ┌───────────────┐               │
                        │ State Builder │               │
                        │ Frame→GameState               │
                        └───────┬───────┘               │
                                │                       │
                        ┌───────▼────────┐              │
                        │ Routine Runner │              │
                        │ evaluates `when`              │
                        └───────┬────────┘              │
                                │                       │
                                ▼                       ▼
                        ┌──────────────────────────────────────┐
                        │          ActionScheduler             │
                        │  priority queue: emergency > control │
                        │  > routine > brain, dedupe, rate-lim │
                        └──────────────┬───────────────────────┘
                                       ▼
                               ┌───────────────┐
                               │  Actuator     │
                               │  + InputBackend│
                               │  focus-gated  │
                               └───────┬───────┘
                                       ▼
                               ┌───────────────┐
                               │ Maplestory    │
                               │   window      │
                               └───────────────┘
```

### 2.2 Offline modules

```
  Record command                   Analyze command
  ┌──────────────┐                 ┌────────────────────────┐
  │   Recorder   │    ────►        │    Analyzer (LLM)      │
  │  capture+keys│   recording/    │  sampled frames +      │
  └──────────────┘                 │  input log → routine   │
                                   │  YAML                  │
                                   └────────────────────────┘
```

### 2.3 Module responsibilities

| Module            | Responsibility                                                                          | Cadence     |
|-------------------|------------------------------------------------------------------------------------------|-------------|
| Orchestrator      | Wire modules, load routine, expose CLI, manage lifecycle                                | n/a         |
| CaptureProvider   | Abstract screen capture; returns raw BGRA buffer for a region or window                  | on-demand   |
| Perception        | Run YOLO on captured frame, emit `PerceptionFrame` (raw detections)                     | 5–10 Hz     |
| State Builder     | Convert `PerceptionFrame` → `GameState` (Maplestory-interpreted semantics)              | per frame   |
| Reflex            | Sample HP/MP pixel regions; fire emergency-priority actions                              | 60 Hz       |
| Routine Runner    | Evaluate `when` rules and `every` timers, emit routine-priority actions                  | per state   |
| ActionScheduler   | Priority queue, dedupe, interrupt rules, rate limits, key-state tracking                 | continuous  |
| Actuator          | Single choke-point for input; focus-gate; pause/resume; wraps `InputBackend`             | on-demand   |
| InputBackend      | Platform-specific injection (`ForegroundBackend` for v1)                                 | on-demand   |
| Recorder          | Capture keys + screenshots during a demonstration; write `recording/`                    | 5 Hz frames |
| Analyzer          | One-shot offline LLM call; reads recording; writes `routine.yaml`                        | one-shot    |

---

## 3. Tech Stack

All code TypeScript. Node 20 LTS. No Python in the runtime.

### 3.1 Runtime dependencies

| Purpose               | Package                          |
|-----------------------|----------------------------------|
| Screen capture        | `screenshot-desktop`             |
| Image resize / decode | `sharp`                          |
| YOLO inference        | `onnxruntime-node`               |
| Input injection       | `@nut-tree-fork/nut-js`          |
| Schema validation     | `zod`                            |
| YAML parse/write      | `yaml`                           |
| CLI                   | `commander` + `chalk`            |
| Logging               | `pino`                           |
| Global hotkeys        | `node-global-key-listener`       |
| Offline LLM           | `@anthropic-ai/sdk`              |
| Future server         | `fastify` (shipped, unused in v1)|

### 3.2 Dev dependencies

`typescript`, `tsx`, `vitest`, `@vitest/ui`, `eslint`, `@typescript-eslint/*`, `prettier`, `simple-git-hooks`, `@types/node`.

### 3.3 External services / assets

| Item                            | When needed            | Notes                            |
|---------------------------------|------------------------|----------------------------------|
| Anthropic API key               | `analyze` command only | `$0.05–0.15` per recording       |
| `yolov8n-maplestory.onnx` (~6MB)| first `run` or `doctor`| Auto-downloaded to `./models/`   |
| Ollama                          | **not used in v1**     | May be added in v2 for live brain|

### 3.4 Cross-platform notes

- **Windows 10/11 x64.** No admin rights required. Antivirus may flag `nut.js` or `screenshot-desktop` — whitelist the Node binary path.
- **macOS 13+ (Intel + Apple Silicon via Rosetta for v1).** Requires Accessibility + Screen Recording permission for the terminal.

---

## 4. Environment Requirements

### 4.1 Hardware minimums

| Component | Minimum                | Recommended               |
|-----------|------------------------|---------------------------|
| CPU       | 4-core x64 @ 2.5 GHz   | 6+ core @ 3.0 GHz         |
| RAM       | 4 GB free for bot      | 8 GB                      |
| GPU       | none (CPU YOLO works)  | NVIDIA CUDA or Apple MPS  |
| Disk      | 500 MB (models + one recording) | 2 GB (many recordings) |

### 4.2 Prerequisites

- **Node.js 20 LTS (≥ 20.11)**
- **pnpm ≥ 9.0** (or npm/yarn)
- **Python: not required**
- **Ollama: not required in v1**

### 4.3 Permissions

**Windows**
- Run as standard user.
- Add `node.exe` (or the compiled binary) to antivirus whitelist if flagged.

**macOS**
- System Settings → Privacy & Security → **Accessibility** → add Terminal (or iTerm / VS Code).
- System Settings → Privacy & Security → **Screen Recording** → same.
- First `record` / `run` triggers the prompts; user approves once.

### 4.4 `maplestory.ai doctor` validates

1. Node version ≥ 20.
2. Platform prebuilds present for `sharp`, `onnxruntime-node`, `@nut-tree-fork/nut-js`.
3. Mac: Accessibility + Screen Recording granted.
4. `models/yolov8n-maplestory.onnx` present (downloads if missing).
5. `ANTHROPIC_API_KEY` set (warning only — needed only for `analyze`).
6. Maplestory window discoverable by title pattern (optional — only if game running).
7. Capture smoke test → measures per-frame latency.
8. `nut.js` keypress smoke test into a scratch text field.

Prints a green/red summary. Exits 0/1 accordingly.

---

## 5. Type Contracts

All shared types live in `src/core/types.ts` with `zod` schemas. The review-driven split between **raw perception** and **interpreted state** is adopted.

```ts
import { z } from 'zod'

// ─── Geometry ────────────────────────────────────────────
export const Rect = z.object({
  x: z.number(), y: z.number(), w: z.number(), h: z.number(),
})
export const Vec2 = z.object({ x: z.number(), y: z.number() })

// ─── Perception (raw) ────────────────────────────────────
export const Detection = z.object({
  class: z.string(),                 // 'player' | 'mob_generic' | 'rune' | 'portal'
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),  // x,y,w,h
  confidence: z.number().min(0).max(1),
})

export const OcrBlock = z.object({
  text: z.string(),
  bbox: Rect,
  confidence: z.number(),
})

export const PerceptionFrame = z.object({
  timestamp: z.number(),
  detections: z.array(Detection),
  ocr: z.array(OcrBlock).optional(),
  screenshotMeta: z.object({ width: z.number(), height: z.number() }),
  overallConfidence: z.number().min(0).max(1),
})
export type PerceptionFrame = z.infer<typeof PerceptionFrame>

// ─── GameState (Maplestory-interpreted) ──────────────────
export const PopupState = z.object({
  text: z.string(),
  kind: z.enum(['event', 'dc', 'gm', 'unknown']),
})

export const EnemyState = z.object({
  type: z.string(),
  pos: Vec2,
  distancePx: z.number(),
})

export const GameState = z.object({
  timestamp: z.number(),
  player: z.object({
    pos: Vec2.nullable(),         // minimap coords (canonical)
    screenPos: Vec2.nullable(),   // screen coords from YOLO (for mob distance)
    hp: z.number().min(0).max(1),
    mp: z.number().min(0).max(1),
  }),
  enemies: z.array(EnemyState),
  flags: z.object({ runeActive: z.boolean(), outOfBounds: z.boolean() }),
  popup: PopupState.nullable(),
})
export type GameState = z.infer<typeof GameState>

// ─── Actions ─────────────────────────────────────────────
export const Action = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('press'),  key: z.string(), holdMs: z.number().optional() }),
  z.object({ kind: z.literal('combo'),  keys: z.array(z.string()), interKeyMs: z.number().optional() }),
  z.object({ kind: z.literal('move'),   direction: z.enum(['left','right','up','down']), ms: z.number() }),
  z.object({ kind: z.literal('wait'),   ms: z.number() }),
  z.object({ kind: z.literal('abort'),  reason: z.string() }),
])
export type Action = z.infer<typeof Action>

export type ActionSource = 'reflex' | 'routine' | 'brain' | 'manual'
export type ActionPriority = 'emergency' | 'control' | 'routine' | 'background'
```

### 5.1 Module interfaces

```ts
// ─── Capture ─────────────────────────────────────────────
export interface CaptureProvider {
  captureScreen(): Promise<Buffer>          // raw BGRA
  captureRegion(rect: Rect): Promise<Buffer>
  captureWindow(titlePattern: string): Promise<Buffer>
  canCaptureBackground(): boolean           // true for Windows GraphicsCapture in v2
}

// ─── Perception ──────────────────────────────────────────
export interface Perception {
  start(): Promise<void>
  stop(): Promise<void>
  onFrame(cb: (frame: PerceptionFrame) => void): void
}

// ─── State building ──────────────────────────────────────
export interface StateBuilder {
  build(frame: PerceptionFrame, hpReflex: number, mpReflex: number): GameState
}

// ─── Reflex ──────────────────────────────────────────────
export interface Reflex {
  start(): Promise<void>
  stop(): Promise<void>
  current(): { hp: number; mp: number }
}

// ─── Routine ─────────────────────────────────────────────
export interface RoutineRunner {
  load(yamlPath: string): Promise<void>
  tick(state: GameState): Promise<void>   // emits actions via scheduler
}

// ─── Scheduler ───────────────────────────────────────────
export interface ActionScheduler {
  submit(source: ActionSource, action: Action, priority: ActionPriority): void
  tick(): Promise<void>                    // drains queue with priority + dedupe
  clear(source?: ActionSource): void
}

// ─── Actuator + InputBackend ─────────────────────────────
export interface Actuator {
  execute(action: Action): Promise<void>
  isGameFocused(): boolean
  pause(): void
  resume(): void
  abort(): void
  setTargetWindow(pattern: string): void
}

export interface InputBackend {
  sendKey(key: string, holdMs: number): Promise<void>
  sendCombo(keys: string[], interKeyMs: number): Promise<void>
  sendMove(dir: 'left'|'right'|'up'|'down', ms: number): Promise<void>
  canRunBackground(): boolean
}

// ─── Typed event bus ─────────────────────────────────────
export interface TypedBus {
  on<T extends keyof BusEvents>(ev: T, cb: (p: BusEvents[T]) => void): void
  emit<T extends keyof BusEvents>(ev: T, payload: BusEvents[T]): void
}
export type BusEvents = {
  'perception.frame': PerceptionFrame
  'state.built':      GameState
  'reflex.vitals':    { hp: number; mp: number }
  'action.submitted': { source: ActionSource; action: Action; priority: ActionPriority }
  'action.executed':  { action: Action; backend: string; timing: number }
  'actuator.pause':   { reason: string }
  'actuator.resume':  {}
  'run.mode':         { mode: 'dry-run' | 'safe' | 'live' }
}

// ─── Clock (injectable for tests) ────────────────────────
export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
  setInterval(fn: () => void, ms: number): () => void
}
```

### 5.2 Pause / abort / suspend — distinct semantics

Per review feedback, three states are formalized:

| State    | Trigger                                   | In-flight preserved?     | Timers                                |
|----------|--------------------------------------------|---------------------------|----------------------------------------|
| pause    | User F10, focus loss                      | Yes (resume continues)    | Frozen (cooldowns, stuck detector)    |
| suspend  | Waiting on async work (brain call, model load) | Yes                   | Frozen                                |
| abort    | User F12, unknown popup, stop_condition   | No — state discarded      | Reset                                 |

Scheduler clears pending actions on `abort` and on `pause` (with replay on `resume` configurable per source).

---

## 6. Project Structure

```
maplestory.ai/
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── .eslintrc.cjs
├── .prettierrc
├── vitest.config.ts
├── .env.example                    # ANTHROPIC_API_KEY=
├── .node-version                   # 20
├── .nvmrc                          # 20
├── README.md
├── docs/
│   └── specs/
│       └── 2026-04-24-maplestory-ai-v1-design.md
├── models/                         # gitignored — ONNX weights
├── recordings/                     # gitignored — user demonstrations
├── routines/                       # committable — generated + reviewed YAML
│   └── example-arcana.yaml
├── src/
│   ├── core/
│   │   ├── types.ts                # zod schemas + interfaces
│   │   ├── bus.ts                  # typed event bus
│   │   ├── clock.ts                # real + fake clocks
│   │   ├── orchestrator.ts
│   │   ├── scheduler.ts            # ActionScheduler
│   │   ├── actuator.ts
│   │   ├── focus.ts                # foreground-window detection
│   │   └── logger.ts
│   ├── capture/
│   │   ├── index.ts                # CaptureProvider factory
│   │   ├── screenshot-desktop.ts   # v1 impl
│   │   └── native-windows.ts       # v2 stub
│   ├── input/
│   │   ├── index.ts                # InputBackend factory
│   │   └── foreground-nut.ts       # v1 impl
│   ├── perception/
│   │   ├── yolo.ts
│   │   ├── nms.ts
│   │   └── state-builder.ts
│   ├── reflex/
│   │   └── pixel-sampler.ts
│   ├── routine/
│   │   ├── runner.ts
│   │   ├── dsl.ts                  # `when` expression parser
│   │   └── schema.ts               # zod schema for routine.yaml
│   ├── recorder/
│   │   ├── index.ts
│   │   └── frame-writer.ts
│   ├── analyzer/
│   │   ├── index.ts                # Anthropic SDK call
│   │   ├── prompt.ts
│   │   └── post-process.ts         # validates LLM output against routine schema
│   ├── cli.ts                      # commander entrypoint
│   └── doctor.ts
└── tests/
    ├── unit/                       # scheduler, dsl, reflex metrics, schemas
    ├── snapshot/                   # fixture frames → expected GameState
    └── integration/                # orchestrator with fake clock + fake backend
```

---

## 7. Recording

### 7.1 Workflow

```
$ maplestory.ai record --name arcana-v1
✓ Focus the Maplestory window. Press ENTER when ready.
✓ Recording… (press F12 to stop)
  - frames @ 5Hz → recordings/arcana-v1/frames/NNNN.png
  - keystrokes   → recordings/arcana-v1/inputs.jsonl
  - vitals poll  → recordings/arcana-v1/vitals.jsonl
✓ Stopped after 3m 42s, 1110 frames, 482 keystrokes.
```

### 7.2 Data captured

- **`frames/`** — PNG, 5 Hz, lossless; optionally down-scaled to 960×540 for storage.
- **`inputs.jsonl`** — one JSON per line:
  ```json
  {"t":1234.5,"type":"keydown","key":"ctrl"}
  {"t":1234.6,"type":"keyup",  "key":"ctrl"}
  {"t":1235.1,"type":"keydown","key":"right"}
  ```
- **`vitals.jsonl`** — Reflex pixel-sampler output recorded in parallel:
  ```json
  {"t":1234.5,"hp":0.92,"mp":0.71}
  ```
- **`meta.json`** — resolution, window title, OS, maplestory.ai version, start/end timestamps.

### 7.3 Responsibilities

The Recorder runs only Capture + Reflex + a keyboard listener. It does **not** run the Actuator or ActionScheduler. This keeps recordings pristine (no feedback loop).

---

## 8. Offline Analyzer → routine.yaml

### 8.1 Command

```
$ maplestory.ai analyze recordings/arcana-v1 --out routines/arcana.yaml
✓ Sampling 40 frames (every 28th) from 1110…
✓ Sending to Claude (sonnet-4)…
✓ Parsed response, validated against routine schema.
✓ Wrote routines/arcana.yaml
  - hp_region: x=820 y=1000 w=140 h=14
  - mp_region: x=966 y=1000 w=140 h=14
  - minimap:   x=1820 y=14 w=80 h=60
  - potion_hp_at: 0.30 (ctrl→page_up)
  - potion_mp_at: 0.20 (ctrl→page_down)
  - rotation: 4 rules
  - movement: {mode: waypoints, 6 primitives}
Review the file before running.
```

### 8.2 Prompt shape (abridged)

The analyzer uploads sampled frames + `inputs.jsonl` excerpt + `vitals.jsonl` excerpt. Claude is prompted to return **strict JSON** matching the routine schema. Post-processing validates with zod — invalid output triggers a retry with the validation error appended to the prompt (max 2 retries).

Prompt template lives in `src/analyzer/prompt.ts` and asks Claude to infer:

1. Pixel regions for HP / MP / minimap (from where colors correlate with vitals).
2. Potion keys + thresholds (from timing of `keydown` events vs vitals drops).
3. Attack keys + mob-distance threshold (from clicks/keypresses near YOLO-detected mobs when a pre-shipped model is available; else from frame diffs + key cadence).
4. Movement primitive sequence compiled from user's keyboard path (§12).
5. Buff cadence (keys pressed on long periodic intervals).

### 8.3 Routine YAML shape (v1)

```yaml
game: maplestory
recorded_from: recordings/arcana-v1
resolution: [1920, 1080]
window_title: "MapleStory"

regions:
  hp:      { x: 820,  y: 1000, w: 140, h: 14 }
  mp:      { x: 966,  y: 1000, w: 140, h: 14 }
  minimap: { x: 1820, y: 14,   w: 80,  h: 60 }
  popup:   { x: 660,  y: 420,  w: 600, h: 240 }

reflex:
  - { region: hp, metric: red_pixel_ratio,  below: 0.30, cooldown_ms: 800, action: { kind: press, key: page_up   } }
  - { region: mp, metric: blue_pixel_ratio, below: 0.20, cooldown_ms: 800, action: { kind: press, key: page_down } }

perception:
  model: yolov8n-maplestory
  fps: 8
  classes: [player, mob_generic, rune, portal]
  confidence_threshold: 0.6

rotation:
  - when: mobs_in_range(300) >= 3
    action: { kind: press, key: d }
    cooldown_ms: 1200
  - when: mobs_in_range(300) >= 1
    action: { kind: press, key: ctrl }
    cooldown_ms: 500
  - every: 30s
    action: { kind: press, key: shift }
  - every: 3m
    action: { kind: press, key: f1 }

movement:
  primitives:
    - { op: walk_to_x,   x: 30  }
    - { op: walk_to_x,   x: 170 }
    - { op: walk_to_x,   x: 30  }
  loop: true
  pause_while_attacking: true

stop_condition:
  or:
    - duration: 2h
    - hp_persist_below: { value: 0.15, seconds: 5 }
    - popup_detected: true
    - out_of_bounds: { margin: 10 }

bounds:
  x: [25, 205]
  y: [40, 130]
minimap_player_color:
  hsv_target: [50, 200, 220]   # yellow dot
  tolerance:  20
```

### 8.4 Review gate

`run` refuses to execute a routine marked `unreviewed: true` in its header. The analyzer writes that flag on first generation; removing it is the user's explicit approval.

---

## 9. Perception — YOLO

### 9.1 Pipeline

```
 capture ──► sharp resize 640×640 ──► onnxruntime-node YOLOv8n ──► NMS ──► PerceptionFrame
  5-30ms            5-15ms                     15-40ms CPU           1-3ms
```

Target total < 100 ms per tick on Windows CPU. Measured in `doctor` and warned if above 150 ms.

### 9.2 State Builder

Pure function. Input: `PerceptionFrame` + latest Reflex vitals + latest minimap position (§9.4). Output: `GameState`:

- `state.player.pos` = **minimap coords** `(mx, my)` from the Minimap Sampler — NOT YOLO bbox center. This is the canonical position used by movement and `mobs_in_range` calculations that need spatial reasoning.
- `state.player.screenPos` = highest-confidence `player` YOLO detection center (screen coords) — used for mob-distance calculations because mobs are in screen coords too.
- For each `mob_*` detection, compute `distancePx` from `state.player.screenPos` (screen-space) → `state.enemies[]`.
- `state.player.hp/mp` = Reflex cached value (NOT from YOLO).
- `state.flags.runeActive` = any detection with `class:"rune"` and `confidence >= 0.75`.
- `state.popup` = fallthrough: OCR on `regions.popup` if YOLO flags unknown overlay OR if state has been static > N seconds.

### 9.4 Minimap Sampler

Maplestory's minimap is a small top-down rectangle (typically top-right corner). The player appears as a single bright colored dot (yellow by default) on it. The minimap is the **only stable spatial coordinate system** across resolution variants and camera scrolls.

**Pipeline:**

```
 capture minimap region (regions.minimap)
   ──► sharp raw RGBA buffer
   ──► find brightest pixel cluster matching player-dot HSV target
   ──► return (mx, my) in minimap-local coordinates
```

The sampler runs in the same cadence as Perception. Implementation: pure pixel scan over the cropped minimap buffer; not ML. Latency: < 5 ms per call.

**Why minimap not YOLO for position:**

- Minimap coords are stable; screen-space player position changes when camera scrolls.
- A trajectory in minimap space is directly comparable across recording and live run.
- Minimap detection is robust to player class / cosmetic skin / animation frame.

### 9.5 Map bounds

The Analyzer derives `bounds: { x: [min, max], y: [min, max] }` from the recording's minimap trajectory (the extents of `(mx, my)` over the whole session). Stored in routine YAML. At runtime the orchestrator aborts if the live `(mx, my)` exits `bounds` by a configurable margin (default 10 px) — this catches knockback / unexpected map changes.

### 9.3 Training (parallel track)

- ~500 labeled Maplestory screenshots (player, mob_generic, rune, portal).
- Train YOLOv8n via `ultralytics` in a Colab notebook, ~50 epochs.
- Export to ONNX, publish as GitHub release asset.
- Does **not** block runtime development — phases 0–6 can use a placeholder model with lenient thresholds.

---

## 10. Reflex

Pure pixel sampling inside worker thread at 60 Hz. No ML.

- Crop HP/MP regions from the captured frame (cache frame from Capture provider).
- Count colored pixels (`red_pixel_ratio` = red>150 && green<80 && blue<80 fraction).
- If below threshold and cooldown expired → submit `Action` to ActionScheduler with priority `emergency`.
- Persist current vitals in a shared ring buffer for State Builder.

---

## 11. ActionScheduler + Actuator + InputBackend

### 11.1 ActionScheduler

Central arbiter. Every producer submits here; nothing touches the Actuator directly except the Actuator itself.

**Priorities** (high → low):

| Priority    | Typical producer | Example action                 |
|-------------|------------------|--------------------------------|
| emergency   | Reflex           | HP < 30 → press potion         |
| control     | Orchestrator     | Kill-switch, safe-mode clamp   |
| routine     | Routine Runner   | Attack skill, buff, movement   |
| background  | Brain (future)   | Strategic repositioning        |

**Rules:**

- Higher-priority `press` on a key preempts any in-flight lower-priority hold on the same key.
- Dedupe: same `press` within `cooldown_ms` for same source is dropped.
- Rate limit: max 20 actions/sec global ceiling; per-key 10/sec.
- Key-state tracking: scheduler knows which keys it currently holds down, prevents "double keydown" that some games treat as no-op.
- On `pause`: queue frozen; `resume` replays queue minus stale `routine` entries older than `now - 500ms`.
- On `abort`: queue cleared, all held keys released.

### 11.2 Actuator

- Single call path to the OS. `execute(action)` translates to `InputBackend` calls.
- Focus-gated: if `!isGameFocused()`, logs and drops the action (except `abort`).
- Randomized micro-delays (±20 ms jitter) to avoid exact-cadence patterns (quality, not anti-cheat).
- Releases all held keys on `pause`, `abort`, process exit, uncaught exception.

### 11.3 InputBackend

v1 ships **`ForegroundBackend`** (nut.js SendInput, focus required). The interface is stable for future backends:

| Backend                     | OS      | Background | Status       |
|-----------------------------|---------|------------|--------------|
| `ForegroundBackend`         | Win/Mac | ❌         | **v1 ships** |
| `WindowMessageBackend`      | Windows | ✅         | v2           |
| `PidTargetedBackend`        | Mac     | ✅         | v2           |
| `InterceptionBackend`       | Windows | ✅✅        | v3 research  |
| `VMBackend`                 | Both    | ✅✅✅       | v3 research  |

The scheduler and actuator do **not** change when a new backend lands — only the InputBackend factory.

### 11.4 Hotkey listener (global)

- `F10` → pause / resume toggle
- `F12` → abort
- `F9`  → emit a marker into the log (debugging)

Listener uses `node-global-key-listener`. Runs outside the scheduler — hotkeys bypass all gates.

---

## 12. Movement Primitives

Per review: raw waypoint pairs `{x,y}` are not enough. v1 uses a small movement-primitive layer. The analyzer emits primitives directly; the runtime executes them.

| Primitive       | Args            | Semantics                                    |
|-----------------|-----------------|----------------------------------------------|
| `walk_to_x`     | `x`             | Hold left/right until player x within ±5px   |
| `jump_left`     | `holdMs?`       | Jump arc left                                |
| `jump_right`    | `holdMs?`       | Jump arc right                               |
| `drop_down`     |                 | Down + jump                                  |
| `climb_rope`    | `duration?`     | Up, release at end of rope                   |
| `teleport_left` | `repeats?`      | Class-specific; analyzer flags if class binds teleport |
| `teleport_right`| `repeats?`      | same                                         |
| `wait`          | `ms`            | Pause                                        |

v1 ships `walk_to_x`, `jump_left`, `jump_right`, `drop_down`, `wait`. Others scaffolded for v1.1.

`pause_while_attacking: true` halts the primitive state machine while the rotation is firing on visible mobs.

---

## 13. Run Modes

Three modes, selected by `--mode` flag:

| Mode      | Input sent?                   | Timing     | Logging                     | Use case                |
|-----------|--------------------------------|------------|-----------------------------|--------------------------|
| `dry-run` | No — actions logged only       | Real       | Every action + state        | Validate routine logic   |
| `safe`    | Only `emergency` + `control`  | Real       | Verbose + hard 5-min cutoff | First live tests         |
| `live`    | All                            | Real       | Standard                    | Production grinding      |

`dry-run` is the **default** for a freshly-analyzed routine. User must pass `--mode live` explicitly after dry-run looks good.

---

## 14. Testing Strategy

| Scope           | Kind       | Tool   | Validates                                              |
|------------------|------------|--------|--------------------------------------------------------|
| Schemas          | Unit       | vitest | zod rejects malformed PerceptionFrame, GameState, routine.yaml |
| DSL parser       | Unit       | vitest | `when` whitelist, nested ops, invalid keywords rejected |
| Scheduler        | Unit       | vitest | Priority order, dedupe, rate limit, key-state, pause/resume |
| Reflex metrics   | Unit       | vitest | Pixel ratios on synthetic bitmaps                       |
| State Builder    | Unit       | vitest | Pure function: PerceptionFrame → expected GameState    |
| Movement FSM     | Unit       | vitest | Primitive execution with fake clock                     |
| Perception       | Snapshot   | vitest | Fixture PNG → expected GameState (stable YOLO build)   |
| Orchestrator     | Integration| vitest | Fake clock + fake backend + fixture stream             |
| Replay           | Integration| vitest | Recorded artifact → deterministic re-run               |
| Analyzer output  | Golden     | vitest | Canned LLM response → valid routine YAML               |
| End-to-end       | Manual     | logs   | Real 30-min Maplestory run, reviewed against golden log|

### 14.1 Clock abstraction

All timing (cooldowns, timers, stuck detector, primitive FSM) goes through `Clock`. Tests inject `FakeClock` with `tick(ms)` to advance time deterministically.

### 14.2 Replay artifacts

`run` writes `recordings/runs/YYYY-MM-DD-HHMM/`:

- `frames/` — sampled frames
- `perception.jsonl` — raw PerceptionFrame stream
- `states.jsonl` — derived GameState stream
- `actions.jsonl` — scheduler submissions + actuator executions
- `events.jsonl` — bus events (pause, resume, abort)

Used for regression, debugging, and feeding the replay integration test.

---

## 15. MVP Scope

**In:**

- Recorder CLI + storage format
- Offline Analyzer calling Anthropic API, emitting validated routine YAML
- Runtime: CaptureProvider (`screenshot-desktop`), Perception (YOLOv8n), StateBuilder, Reflex, RoutineRunner, ActionScheduler, Actuator (`ForegroundBackend`), Orchestrator
- Movement primitives: `walk_to_x`, `jump_left`, `jump_right`, `drop_down`, `wait`
- Routine `when` DSL whitelist
- Run modes: `dry-run`, `safe`, `live`
- Global hotkeys F10/F12
- CLI: `record`, `analyze`, `run`, `doctor`
- Replay artifact writer
- Tests: unit + snapshot + integration

**Out (deferred):**

- Rune solver
- Brain layer / Ollama / live LLM
- Background InputBackend (window message / interception / VM)
- Calibration wizard
- Web dashboard
- Multiple game support (that is Faker.ai)
- Rope/climb/teleport movement primitives (scaffolded only)

---

## 16. Work Phases (realistic — 2-4 weeks solo)

### Phase 0 — Bootstrap (0.5 day)
TS repo, lint, prettier, vitest, commander skeleton, typed bus, Clock interface with real + fake impls. `doctor` command shell.
**Deliverable:** `pnpm test` green, `maplestory.ai doctor` prints version.

### Phase 1 — Core + Actuator + Scheduler (2 days)
Types, zod schemas, focus detection, `ForegroundBackend`, Actuator with focus-gating, ActionScheduler with priority/dedupe/rate/pause/resume. Global hotkeys.
**Deliverable:** CLI test harness that queues mixed-priority actions and prints the emitted sequence; F10 pauses.

### Phase 2 — Capture + Reflex (1.5 days)
`CaptureProvider` v1 impl, 60 Hz Reflex worker with pixel metrics. Doctor measures capture latency.
**Deliverable:** `maplestory.ai doctor` reports capture + reflex latencies; reflex fires synthetic potion on low-HP fixtures.

### Phase 3 — Perception + State Builder (3 days)
Sharp preprocess, ONNX YOLO loader, NMS, distance calc, State Builder, snapshot tests.
**Deliverable:** pipe 20 fixture frames → deterministic `GameState` stream.

### Phase 4 — Routine DSL + Runner + Movement (2 days)
YAML schema + `when` parser (whitelist), Routine Runner, movement-primitive FSM.
**Deliverable:** load `example-arcana.yaml`, fake-clock-drive for 60s, inspect scheduler submissions.

### Phase 5 — Orchestrator + run modes + replay (1.5 days)
Wire all modules, `dry-run`/`safe`/`live`, replay artifact writer.
**Deliverable:** `run --mode dry-run routines/example-arcana.yaml` executes end-to-end without input.

### Phase 6 — Recorder (1 day)
Input + frame + vitals capture into `recordings/<name>/`. Stop on F12.
**Deliverable:** `record --name test`, stop, inspect recording dir.

### Phase 7 — Analyzer (2 days)
Anthropic SDK client, prompt template, frame sampler, strict-JSON validator with retry, routine YAML writer with `unreviewed: true` flag.
**Deliverable:** analyze a canned recording → valid routine.yaml.

### Phase 8 — Model training + fixture set (parallel — 2 days effort + iteration)
500 labeled screenshots, train YOLOv8n, export ONNX, publish release asset. Build `tests/snapshot/fixtures/` from a real session.
**Deliverable:** `models/yolov8n-maplestory.onnx` shipped; snapshot tests pass.

### Phase 9 — Real-game iteration (3–5 days)
Calibration frictions, timing drift, screenshot throughput tuning, action arbitration edge cases, scripting stability on long runs. Expected to surface 10–20 bugs.
**Deliverable:** **30-minute unsupervised Maplestory grind with zero human intervention.**

### Phase 10 — Polish + README + doctor polish (1 day)
Install docs, quickstart, troubleshooting, `doctor` guidance text, CHANGELOG.
**Deliverable:** clone → `pnpm install` → `doctor` → `record` → `analyze` → `run` works on a fresh machine.

**Total: ~17–19 working days (3–4 calendar weeks solo).**

---

## 17. Risks and Mitigations

| Risk                                                | Mitigation                                                                   |
|-----------------------------------------------------|------------------------------------------------------------------------------|
| YOLO mis-detects mobs on a new map                  | Confidence threshold + `dry-run` mode + easy re-record                       |
| Analyzer produces wrong keys or thresholds          | `unreviewed: true` gate forces user review; dry-run catches most issues      |
| LLM JSON parse failure / schema drift               | zod validation + retry with error appended (max 2)                           |
| Focus loss mid-skill                                | Scheduler releases all held keys; resume replays fresh routine               |
| Race between Reflex pot and Routine combo           | Scheduler priority: emergency preempts routine; key-state tracked            |
| Mac capture latency > 100ms                         | Swap CaptureProvider to native binding; stays behind interface               |
| Nexon client updates regions (patch breaks YAML)    | Re-record + re-analyze takes <10 min; routines versioned per `recorded_from` |
| Antivirus flags nut.js or screenshot-desktop        | README whitelist instructions; signed binary in v1.x                         |
| ToS / account risk                                  | README disclaimer; user responsibility                                       |

---

## 18. Roadmap (post v1)

| Version | Additions                                                                 |
|---------|----------------------------------------------------------------------------|
| v1.1    | Rune solver hook; rope / climb / teleport movement primitives              |
| v1.2    | OCR popup handling (local Tesseract, no cloud)                             |
| v2.0    | Background input via `WindowMessageBackend` (Windows) / `PidTargetedBackend` (Mac) |
| v2.1    | Web monitoring dashboard (fastify server already ships)                    |
| v2.2    | Live Brain layer via Ollama for stuck / ambiguous popup handling           |
| v3.0    | (migrates to Faker.ai) — adapter abstraction, second game                  |

---

## 19. Deliverables Checklist

- [ ] Repo bootstrap — TS, pnpm, lint, test, CI
- [ ] Core types (zod) + typed event bus + Clock
- [ ] ForegroundBackend + Actuator + focus-gating
- [ ] ActionScheduler with priorities, dedupe, rate limit, key-state
- [ ] Global hotkeys (F10 pause, F12 abort)
- [ ] CaptureProvider interface + v1 impl
- [ ] 60 Hz Reflex pixel sampler
- [ ] YOLO perception pipeline + NMS
- [ ] State Builder pure function
- [ ] Routine YAML schema + `when` DSL parser (whitelist)
- [ ] Routine Runner + movement-primitive FSM
- [ ] Orchestrator + run modes (dry-run, safe, live)
- [ ] Replay artifact writer
- [ ] Recorder CLI
- [ ] Offline Analyzer (Anthropic SDK + prompt + validate + retry)
- [ ] `doctor` command with all v1 checks
- [ ] YOLOv8n-maplestory ONNX shipped as release asset
- [ ] Snapshot fixtures
- [ ] README + quickstart + troubleshooting
- [ ] 30-minute unsupervised grind demo
