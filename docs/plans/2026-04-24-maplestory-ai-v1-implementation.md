# maplestory.ai v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a record-and-replay desktop tool that automates Maplestory farming via demonstration → LLM analysis → perception-gated routine execution.

**Architecture:** Five runtime modules (Capture, Perception/StateBuilder, Reflex, RoutineRunner, Actuator) coordinated by an Orchestrator and a central ActionScheduler with priority arbitration. Two offline modules: Recorder captures demonstrations; Analyzer (cloud LLM, one-shot) generates routine YAML. Loose coupling via typed event bus.

**Tech Stack:** TypeScript 5.5 / Node 20 LTS / pnpm 9. Dependencies: `onnxruntime-node` (YOLO), `sharp` (image), `screenshot-desktop` (capture), `@nut-tree-fork/nut-js` (input), `zod` (schemas), `yaml`, `commander`, `pino`, `node-global-key-listener`, `@anthropic-ai/sdk`. Tests via `vitest` with injectable `Clock`.

**Spec reference:** [docs/specs/2026-04-24-maplestory-ai-v1-design.md](../specs/2026-04-24-maplestory-ai-v1-design.md)

---

## File Structure (will be created across tasks)

```
maplestory.ai/
├── package.json, tsconfig.json, vitest.config.ts, .eslintrc.cjs, .prettierrc
├── .env.example, .nvmrc, .node-version
├── src/
│   ├── core/
│   │   ├── types.ts            # zod schemas, Action, GameState, PerceptionFrame
│   │   ├── bus.ts              # TypedBus
│   │   ├── clock.ts            # Clock + FakeClock
│   │   ├── logger.ts           # pino setup
│   │   ├── focus.ts            # foreground-window detection
│   │   ├── scheduler.ts        # ActionScheduler
│   │   ├── actuator.ts         # Actuator (focus-gate, pause/abort)
│   │   ├── orchestrator.ts     # Wires everything; run modes
│   │   └── hotkeys.ts          # Global F10/F12 listener
│   ├── capture/
│   │   ├── index.ts            # CaptureProvider factory
│   │   └── screenshot-desktop.ts
│   ├── input/
│   │   ├── index.ts            # InputBackend factory
│   │   └── foreground-nut.ts
│   ├── reflex/
│   │   └── pixel-sampler.ts
│   ├── perception/
│   │   ├── yolo.ts
│   │   ├── nms.ts
│   │   ├── minimap.ts          # findPlayerDot + MinimapSampler
│   │   └── state-builder.ts
│   ├── routine/
│   │   ├── schema.ts           # zod for routine.yaml
│   │   ├── dsl.ts              # `when` parser
│   │   ├── movement.ts         # primitive FSM
│   │   └── runner.ts
│   ├── recorder/
│   │   ├── index.ts
│   │   └── frame-writer.ts
│   ├── analyzer/
│   │   ├── prompt.ts
│   │   ├── post-process.ts
│   │   └── index.ts
│   ├── replay/
│   │   └── writer.ts
│   ├── doctor.ts
│   └── cli.ts
└── tests/
    ├── unit/, snapshot/, integration/
    └── fixtures/
```

---

## Phase 0 — Repo Bootstrap

### Task 0.1: Initialize repo + package.json

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.nvmrc`
- Create: `.node-version`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Initialize directory and pnpm**

```bash
cd /Users/matt/Desktop/Workspace/maplestory.ai
git init
pnpm init
```

- [ ] **Step 2: Write package.json**

```json
{
  "name": "maplestory.ai",
  "version": "0.0.1",
  "type": "module",
  "engines": { "node": ">=20.11.0" },
  "bin": { "maplestory.ai": "./dist/cli.js" },
  "scripts": {
    "build": "tsc -p .",
    "dev": "tsx src/cli.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src tests",
    "format": "prettier --write src tests"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.24.0",
    "@nut-tree-fork/nut-js": "^4.2.0",
    "chalk": "^5.3.0",
    "commander": "^12.1.0",
    "fastify": "^4.28.0",
    "node-global-key-listener": "^0.3.0",
    "onnxruntime-node": "^1.18.0",
    "pino": "^9.0.0",
    "screenshot-desktop": "^1.15.0",
    "sharp": "^0.33.0",
    "yaml": "^2.4.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "@vitest/ui": "^2.0.0",
    "eslint": "^9.0.0",
    "prettier": "^3.3.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "baseUrl": "./",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

- [ ] **Step 4: Write .nvmrc and .node-version (both contain "20")**

```
20
```

- [ ] **Step 5: Write .gitignore**

```
node_modules
dist
*.log
.env
models/
recordings/
.DS_Store
.vscode
.idea
coverage
```

- [ ] **Step 6: Write .env.example**

```
ANTHROPIC_API_KEY=
LOG_LEVEL=info
```

- [ ] **Step 7: Install + verify tsc**

Run: `pnpm install && npx tsc --noEmit`
Expected: no errors (tsc reports nothing because no src yet — will treat as "no input files" but exits 0 with `--noEmit` if we add an empty src/index.ts; quickest fix below).

Run: `mkdir -p src && echo 'export {}' > src/index.ts && npx tsc --noEmit`
Expected: clean exit code 0.

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "chore: bootstrap pnpm + tsconfig + node 20 pin"
```

### Task 0.2: ESLint + Prettier + Vitest

**Files:**
- Create: `.eslintrc.cjs`
- Create: `.prettierrc`
- Create: `vitest.config.ts`

- [ ] **Step 1: Write .eslintrc.cjs**

```js
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-module-boundary-types': 'off',
  },
}
```

- [ ] **Step 2: Write .prettierrc**

```json
{ "semi": false, "singleQuote": true, "printWidth": 100, "trailingComma": "all" }
```

- [ ] **Step 3: Write vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 10_000,
  },
  resolve: { alias: { '@': new URL('./src/', import.meta.url).pathname } },
})
```

- [ ] **Step 4: Verify lint and test commands**

Run: `pnpm lint`
Expected: lint passes (no files to lint yet, exits 0).

Run: `pnpm test`
Expected: vitest finds 0 test files, exits 0.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "chore: add eslint, prettier, vitest config"
```

---

## Phase 1 — Core Types + Clock + Bus + Logger

### Task 1.1: Define core zod schemas

**Files:**
- Create: `src/core/types.ts`
- Test: `tests/unit/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/types.test.ts
import { describe, it, expect } from 'vitest'
import { Action, GameState, PerceptionFrame, Rect } from '@/core/types'

describe('zod schemas', () => {
  it('rejects malformed Rect', () => {
    expect(() => Rect.parse({ x: 1, y: 2 })).toThrow()
  })

  it('parses press Action', () => {
    const a = Action.parse({ kind: 'press', key: 'ctrl' })
    expect(a.kind).toBe('press')
  })

  it('rejects Action with bad kind', () => {
    expect(() => Action.parse({ kind: 'bogus' })).toThrow()
  })

  it('parses minimal GameState', () => {
    const s = GameState.parse({
      timestamp: 0,
      player: { pos: null, screenPos: null, hp: 1, mp: 1 },
      enemies: [],
      flags: { runeActive: false, outOfBounds: false },
      popup: null,
    })
    expect(s.player.hp).toBe(1)
  })

  it('parses minimal PerceptionFrame', () => {
    const f = PerceptionFrame.parse({
      timestamp: 0,
      detections: [],
      screenshotMeta: { width: 1920, height: 1080 },
      overallConfidence: 1,
    })
    expect(f.detections).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/types.test.ts`
Expected: fail — module `@/core/types` not found.

- [ ] **Step 3: Implement types.ts**

```ts
// src/core/types.ts
import { z } from 'zod'

export const Rect = z.object({
  x: z.number(), y: z.number(), w: z.number(), h: z.number(),
})
export type Rect = z.infer<typeof Rect>

export const Vec2 = z.object({ x: z.number(), y: z.number() })
export type Vec2 = z.infer<typeof Vec2>

export const Detection = z.object({
  class: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  confidence: z.number().min(0).max(1),
})
export type Detection = z.infer<typeof Detection>

export const OcrBlock = z.object({
  text: z.string(),
  bbox: Rect,
  confidence: z.number(),
})
export type OcrBlock = z.infer<typeof OcrBlock>

export const PerceptionFrame = z.object({
  timestamp: z.number(),
  detections: z.array(Detection),
  ocr: z.array(OcrBlock).optional(),
  screenshotMeta: z.object({ width: z.number(), height: z.number() }),
  overallConfidence: z.number().min(0).max(1),
})
export type PerceptionFrame = z.infer<typeof PerceptionFrame>

export const PopupState = z.object({
  text: z.string(),
  kind: z.enum(['event', 'dc', 'gm', 'unknown']),
})
export type PopupState = z.infer<typeof PopupState>

export const EnemyState = z.object({
  type: z.string(),
  pos: Vec2,
  distancePx: z.number(),
})
export type EnemyState = z.infer<typeof EnemyState>

export const GameState = z.object({
  timestamp: z.number(),
  player: z.object({
    pos: Vec2.nullable(),         // minimap coords (canonical)
    screenPos: Vec2.nullable(),   // YOLO bbox center (screen coords) for mob distance
    hp: z.number().min(0).max(1),
    mp: z.number().min(0).max(1),
  }),
  enemies: z.array(EnemyState),
  flags: z.object({ runeActive: z.boolean(), outOfBounds: z.boolean() }),
  popup: PopupState.nullable(),
})
export type GameState = z.infer<typeof GameState>

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

export const PRIORITY_ORDER: Record<ActionPriority, number> = {
  emergency: 0, control: 1, routine: 2, background: 3,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/types.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts tests/unit/types.test.ts
git commit -m "feat(core): zod schemas for PerceptionFrame, GameState, Action"
```

### Task 1.2: Clock abstraction + FakeClock

**Files:**
- Create: `src/core/clock.ts`
- Test: `tests/unit/clock.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/clock.test.ts
import { describe, it, expect } from 'vitest'
import { FakeClock, RealClock } from '@/core/clock'

describe('FakeClock', () => {
  it('advances time on tick()', () => {
    const c = new FakeClock(1000)
    expect(c.now()).toBe(1000)
    c.tick(500)
    expect(c.now()).toBe(1500)
  })

  it('runs scheduled intervals on tick', () => {
    const c = new FakeClock(0)
    let count = 0
    c.setInterval(() => count++, 100)
    c.tick(350)
    expect(count).toBe(3)
  })

  it('sleep() resolves when ticked', async () => {
    const c = new FakeClock(0)
    let done = false
    const p = c.sleep(50).then(() => { done = true })
    c.tick(50)
    await p
    expect(done).toBe(true)
  })
})

describe('RealClock', () => {
  it('now() returns current time', () => {
    const c = new RealClock()
    const n = c.now()
    expect(n).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/clock.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement clock.ts**

```ts
// src/core/clock.ts
export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
  setInterval(fn: () => void, ms: number): () => void
}

export class RealClock implements Clock {
  now() { return Date.now() }
  sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)) }
  setInterval(fn: () => void, ms: number) {
    const h = setInterval(fn, ms)
    return () => clearInterval(h)
  }
}

interface PendingSleep { wakeAt: number; resolve: () => void }
interface PendingInterval { every: number; nextAt: number; fn: () => void; cancelled: boolean }

export class FakeClock implements Clock {
  private t: number
  private sleeps: PendingSleep[] = []
  private intervals: PendingInterval[] = []
  constructor(start = 0) { this.t = start }

  now() { return this.t }

  sleep(ms: number) {
    return new Promise<void>(resolve => {
      this.sleeps.push({ wakeAt: this.t + ms, resolve })
    })
  }

  setInterval(fn: () => void, ms: number) {
    const i: PendingInterval = { every: ms, nextAt: this.t + ms, fn, cancelled: false }
    this.intervals.push(i)
    return () => { i.cancelled = true }
  }

  tick(ms: number) {
    const target = this.t + ms
    while (this.t < target) {
      const nextSleep  = this.sleeps.length ? Math.min(...this.sleeps.map(s => s.wakeAt)) : Infinity
      const nextIntv   = this.intervals.filter(i => !i.cancelled).length
        ? Math.min(...this.intervals.filter(i => !i.cancelled).map(i => i.nextAt))
        : Infinity
      const next = Math.min(nextSleep, nextIntv, target)
      this.t = next
      // resolve sleeps
      const due = this.sleeps.filter(s => s.wakeAt <= this.t)
      this.sleeps = this.sleeps.filter(s => s.wakeAt > this.t)
      due.forEach(s => s.resolve())
      // fire intervals
      for (const iv of this.intervals) {
        while (!iv.cancelled && iv.nextAt <= this.t) {
          iv.fn()
          iv.nextAt += iv.every
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/clock.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/core/clock.ts tests/unit/clock.test.ts
git commit -m "feat(core): Clock interface + FakeClock for tests"
```

### Task 1.3: Typed event bus

**Files:**
- Create: `src/core/bus.ts`
- Test: `tests/unit/bus.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/bus.test.ts
import { describe, it, expect } from 'vitest'
import { TypedBus } from '@/core/bus'

describe('TypedBus', () => {
  it('delivers events to subscribers', () => {
    const bus = new TypedBus()
    const received: number[] = []
    bus.on('reflex.vitals', p => received.push(p.hp))
    bus.emit('reflex.vitals', { hp: 0.5, mp: 0.7 })
    expect(received).toEqual([0.5])
  })

  it('supports multiple subscribers', () => {
    const bus = new TypedBus()
    let a = 0, b = 0
    bus.on('reflex.vitals', () => a++)
    bus.on('reflex.vitals', () => b++)
    bus.emit('reflex.vitals', { hp: 1, mp: 1 })
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  it('off removes subscriber', () => {
    const bus = new TypedBus()
    let count = 0
    const cb = () => count++
    bus.on('reflex.vitals', cb)
    bus.off('reflex.vitals', cb)
    bus.emit('reflex.vitals', { hp: 1, mp: 1 })
    expect(count).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/bus.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement bus.ts**

```ts
// src/core/bus.ts
import type { PerceptionFrame, GameState, Action, ActionSource, ActionPriority } from './types'

export type BusEvents = {
  'perception.frame': PerceptionFrame
  'state.built':      GameState
  'reflex.vitals':    { hp: number; mp: number }
  'action.submitted': { source: ActionSource; action: Action; priority: ActionPriority }
  'action.executed':  { action: Action; backend: string; timing: number }
  'actuator.pause':   { reason: string }
  'actuator.resume':  Record<string, never>
  'actuator.abort':   { reason: string }
  'run.mode':         { mode: 'dry-run' | 'safe' | 'live' }
}

type Listener<T> = (payload: T) => void

export class TypedBus {
  private listeners: { [K in keyof BusEvents]?: Set<Listener<BusEvents[K]>> } = {}

  on<K extends keyof BusEvents>(ev: K, cb: Listener<BusEvents[K]>) {
    const set = (this.listeners[ev] ??= new Set()) as Set<Listener<BusEvents[K]>>
    set.add(cb)
  }

  off<K extends keyof BusEvents>(ev: K, cb: Listener<BusEvents[K]>) {
    this.listeners[ev]?.delete(cb as never)
  }

  emit<K extends keyof BusEvents>(ev: K, payload: BusEvents[K]) {
    this.listeners[ev]?.forEach(cb => (cb as Listener<BusEvents[K]>)(payload))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/bus.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/core/bus.ts tests/unit/bus.test.ts
git commit -m "feat(core): typed event bus"
```

### Task 1.4: pino logger setup

**Files:**
- Create: `src/core/logger.ts`

- [ ] **Step 1: Implement logger**

```ts
// src/core/logger.ts
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'production'
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, singleLine: true } },
})

export type Logger = typeof logger
```

- [ ] **Step 2: Add pino-pretty as devDependency**

Run: `pnpm add -D pino-pretty`

- [ ] **Step 3: Smoke test**

Run: `pnpm tsx -e "import('./src/core/logger.ts').then(m => m.logger.info('ok'))"`
Expected: log line printed.

- [ ] **Step 4: Commit**

```bash
git add src/core/logger.ts package.json pnpm-lock.yaml
git commit -m "feat(core): pino logger"
```

---

## Phase 2 — Capture + Input + Actuator

### Task 2.1: CaptureProvider interface + screenshot-desktop impl

**Files:**
- Create: `src/capture/index.ts`
- Create: `src/capture/screenshot-desktop.ts`
- Test: `tests/unit/capture.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/capture.test.ts
import { describe, it, expect, vi } from 'vitest'
import { ScreenshotDesktopCapture } from '@/capture/screenshot-desktop'

vi.mock('screenshot-desktop', () => ({
  default: vi.fn(async () => Buffer.from([0xff, 0x00, 0x00, 0xff])),
}))
vi.mock('sharp', () => {
  const mock = () => ({
    extract: vi.fn(() => mock()),
    raw: vi.fn(() => mock()),
    toBuffer: vi.fn(async () => Buffer.from([0xff, 0x00, 0x00, 0xff])),
    metadata: vi.fn(async () => ({ width: 100, height: 100, channels: 4 })),
  })
  return { default: mock }
})

describe('ScreenshotDesktopCapture', () => {
  it('captureScreen returns Buffer', async () => {
    const c = new ScreenshotDesktopCapture()
    const buf = await c.captureScreen()
    expect(Buffer.isBuffer(buf)).toBe(true)
  })

  it('canCaptureBackground returns false in v1', () => {
    const c = new ScreenshotDesktopCapture()
    expect(c.canCaptureBackground()).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/capture.test.ts`
Expected: fail — modules not found.

- [ ] **Step 3: Implement interface**

```ts
// src/capture/index.ts
import type { Rect } from '@/core/types'

export interface CaptureProvider {
  captureScreen(): Promise<Buffer>
  captureRegion(rect: Rect): Promise<Buffer>
  captureWindow(titlePattern: string): Promise<Buffer>
  canCaptureBackground(): boolean
}

export { ScreenshotDesktopCapture } from './screenshot-desktop'

export function createCaptureProvider(): CaptureProvider {
  return new (require('./screenshot-desktop').ScreenshotDesktopCapture)()
}
```

- [ ] **Step 4: Implement screenshot-desktop adapter**

```ts
// src/capture/screenshot-desktop.ts
import screenshot from 'screenshot-desktop'
import sharp from 'sharp'
import type { CaptureProvider } from './index'
import type { Rect } from '@/core/types'

export class ScreenshotDesktopCapture implements CaptureProvider {
  async captureScreen(): Promise<Buffer> {
    const png = await screenshot({ format: 'png' })
    return sharp(png).raw().toBuffer()
  }

  async captureRegion(rect: Rect): Promise<Buffer> {
    const png = await screenshot({ format: 'png' })
    return sharp(png)
      .extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h })
      .raw()
      .toBuffer()
  }

  async captureWindow(_titlePattern: string): Promise<Buffer> {
    // v1: full screen; future backends will target windows
    return this.captureScreen()
  }

  canCaptureBackground(): boolean {
    return false
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test tests/unit/capture.test.ts`
Expected: 2 passing.

- [ ] **Step 6: Commit**

```bash
git add src/capture tests/unit/capture.test.ts
git commit -m "feat(capture): CaptureProvider interface + screenshot-desktop impl"
```

### Task 2.2: focus.ts foreground-window detection

**Files:**
- Create: `src/core/focus.ts`
- Test: `tests/unit/focus.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/unit/focus.test.ts
import { describe, it, expect } from 'vitest'
import { matchesPattern } from '@/core/focus'

describe('matchesPattern', () => {
  it('matches case-insensitive substring', () => {
    expect(matchesPattern('MapleStory v.245', 'maplestory')).toBe(true)
    expect(matchesPattern('chrome.exe',       'maplestory')).toBe(false)
  })
  it('returns false on null window title', () => {
    expect(matchesPattern(null, 'maplestory')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/focus.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement focus.ts**

```ts
// src/core/focus.ts
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
const execAsync = promisify(exec)

export function matchesPattern(title: string | null, pattern: string): boolean {
  if (!title) return false
  return title.toLowerCase().includes(pattern.toLowerCase())
}

export async function getForegroundWindowTitle(): Promise<string | null> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execAsync(
        `osascript -e 'tell application "System Events" to get name of (process 1 whose frontmost is true)'`,
      )
      return stdout.trim() || null
    } catch { return null }
  }
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execAsync(
        `powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W { [DllImport(\\\"user32.dll\\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\\"user32.dll\\\")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n); public static string T() { var s = new System.Text.StringBuilder(256); GetWindowText(GetForegroundWindow(), s, 256); return s.ToString(); } }'; [W]::T()"`,
      )
      return stdout.trim() || null
    } catch { return null }
  }
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/focus.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/core/focus.ts tests/unit/focus.test.ts
git commit -m "feat(core): foreground-window detection (mac + win)"
```

### Task 2.3: InputBackend interface + ForegroundBackend (nut.js)

**Files:**
- Create: `src/input/index.ts`
- Create: `src/input/foreground-nut.ts`
- Test: `tests/unit/input.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/unit/input.test.ts
import { describe, it, expect, vi } from 'vitest'
import { ForegroundNutBackend } from '@/input/foreground-nut'

vi.mock('@nut-tree-fork/nut-js', () => ({
  keyboard: {
    config: { autoDelayMs: 0 },
    pressKey: vi.fn(async () => {}),
    releaseKey: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
  },
  Key: new Proxy({}, { get: (_t, name) => name }),
}))

describe('ForegroundNutBackend', () => {
  it('sendKey calls press then release', async () => {
    const b = new ForegroundNutBackend()
    await b.sendKey('a', 50)
    const nut = await import('@nut-tree-fork/nut-js')
    expect(nut.keyboard.pressKey).toHaveBeenCalled()
    expect(nut.keyboard.releaseKey).toHaveBeenCalled()
  })

  it('canRunBackground returns false', () => {
    const b = new ForegroundNutBackend()
    expect(b.canRunBackground()).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/input.test.ts`
Expected: fail — modules not found.

- [ ] **Step 3: Implement interfaces**

```ts
// src/input/index.ts
export interface InputBackend {
  sendKey(key: string, holdMs: number): Promise<void>
  sendCombo(keys: string[], interKeyMs: number): Promise<void>
  sendMove(dir: 'left'|'right'|'up'|'down', ms: number): Promise<void>
  releaseAll(): Promise<void>
  canRunBackground(): boolean
}

export { ForegroundNutBackend } from './foreground-nut'

export function createInputBackend(): InputBackend {
  return new (require('./foreground-nut').ForegroundNutBackend)()
}
```

```ts
// src/input/foreground-nut.ts
import { keyboard, Key } from '@nut-tree-fork/nut-js'
import type { InputBackend } from './index'

const KEY_MAP: Record<string, string> = {
  ctrl: 'LeftControl', shift: 'LeftShift', alt: 'LeftAlt',
  page_up: 'PageUp', page_down: 'PageDown',
  left: 'Left', right: 'Right', up: 'Up', down: 'Down',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5',
  f6: 'F6', f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',
}

function resolve(key: string): string {
  const k = key.toLowerCase()
  if (KEY_MAP[k]) return KEY_MAP[k]
  if (k.length === 1) return k.toUpperCase()
  // already a Key name
  return key
}

export class ForegroundNutBackend implements InputBackend {
  private held = new Set<string>()

  constructor() { keyboard.config.autoDelayMs = 0 }

  async sendKey(key: string, holdMs: number): Promise<void> {
    const k = resolve(key)
    const KeyAny = Key as unknown as Record<string, number>
    await keyboard.pressKey(KeyAny[k] as unknown as never)
    this.held.add(k)
    if (holdMs > 0) await new Promise(r => setTimeout(r, holdMs))
    await keyboard.releaseKey(KeyAny[k] as unknown as never)
    this.held.delete(k)
  }

  async sendCombo(keys: string[], interKeyMs = 30): Promise<void> {
    for (const k of keys) {
      await this.sendKey(k, 30)
      if (interKeyMs > 0) await new Promise(r => setTimeout(r, interKeyMs))
    }
  }

  async sendMove(dir: 'left'|'right'|'up'|'down', ms: number): Promise<void> {
    await this.sendKey(dir, ms)
  }

  async releaseAll(): Promise<void> {
    const KeyAny = Key as unknown as Record<string, number>
    for (const k of [...this.held]) {
      try { await keyboard.releaseKey(KeyAny[k] as unknown as never) } catch { /* ignore */ }
    }
    this.held.clear()
  }

  canRunBackground(): boolean { return false }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/input.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/input tests/unit/input.test.ts
git commit -m "feat(input): InputBackend interface + ForegroundBackend (nut.js)"
```

### Task 2.4: Actuator with focus-gate, pause/abort

**Files:**
- Create: `src/core/actuator.ts`
- Test: `tests/unit/actuator.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/unit/actuator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { Actuator } from '@/core/actuator'
import type { InputBackend } from '@/input/index'
import { TypedBus } from '@/core/bus'
import { FakeClock } from '@/core/clock'

function fakeBackend(): InputBackend & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    sendKey: vi.fn(async (k, ms) => { calls.push(`key:${k}:${ms}`) }),
    sendCombo: vi.fn(async (ks) => { calls.push(`combo:${ks.join('+')}`) }),
    sendMove: vi.fn(async (d, ms) => { calls.push(`move:${d}:${ms}`) }),
    releaseAll: vi.fn(async () => { calls.push('releaseAll') }),
    canRunBackground: () => false,
  }
}

describe('Actuator', () => {
  it('sends key when game focused', async () => {
    const be = fakeBackend()
    const bus = new TypedBus()
    const a = new Actuator({ backend: be, bus, clock: new FakeClock(), getForegroundTitle: async () => 'MapleStory' })
    a.setTargetWindow('maplestory')
    await a.execute({ kind: 'press', key: 'ctrl' })
    expect(be.calls).toContain('key:ctrl:0')
  })

  it('drops action when game NOT focused', async () => {
    const be = fakeBackend()
    const bus = new TypedBus()
    const a = new Actuator({ backend: be, bus, clock: new FakeClock(), getForegroundTitle: async () => 'Chrome' })
    a.setTargetWindow('maplestory')
    await a.execute({ kind: 'press', key: 'ctrl' })
    expect(be.calls).toEqual([])
  })

  it('pause emits event and drops actions until resume', async () => {
    const be = fakeBackend()
    const bus = new TypedBus()
    let paused = false
    bus.on('actuator.pause', () => { paused = true })
    const a = new Actuator({ backend: be, bus, clock: new FakeClock(), getForegroundTitle: async () => 'MapleStory' })
    a.setTargetWindow('maplestory')
    a.pause('user')
    await a.execute({ kind: 'press', key: 'ctrl' })
    expect(be.calls).toEqual([])
    expect(paused).toBe(true)
    a.resume()
    await a.execute({ kind: 'press', key: 'ctrl' })
    expect(be.calls).toContain('key:ctrl:0')
  })

  it('abort releases all keys', async () => {
    const be = fakeBackend()
    const bus = new TypedBus()
    const a = new Actuator({ backend: be, bus, clock: new FakeClock(), getForegroundTitle: async () => 'MapleStory' })
    a.setTargetWindow('maplestory')
    a.abort('test')
    expect(be.calls).toContain('releaseAll')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/actuator.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement actuator.ts**

```ts
// src/core/actuator.ts
import type { Action } from './types'
import type { InputBackend } from '@/input/index'
import type { TypedBus } from './bus'
import type { Clock } from './clock'

export interface ActuatorOpts {
  backend: InputBackend
  bus: TypedBus
  clock: Clock
  getForegroundTitle: () => Promise<string | null>
  jitterMs?: number
}

export class Actuator {
  private backend: InputBackend
  private bus: TypedBus
  private clock: Clock
  private getFg: () => Promise<string | null>
  private jitter: number
  private targetPattern = ''
  private paused = false
  private aborted = false

  constructor(opts: ActuatorOpts) {
    this.backend = opts.backend
    this.bus = opts.bus
    this.clock = opts.clock
    this.getFg = opts.getForegroundTitle
    this.jitter = opts.jitterMs ?? 20
  }

  setTargetWindow(pattern: string) { this.targetPattern = pattern }

  async isGameFocused(): Promise<boolean> {
    if (!this.targetPattern) return true
    const title = await this.getFg()
    if (!title) return false
    return title.toLowerCase().includes(this.targetPattern.toLowerCase())
  }

  pause(reason = 'user') {
    if (this.paused) return
    this.paused = true
    this.bus.emit('actuator.pause', { reason })
  }

  resume() {
    if (!this.paused) return
    this.paused = false
    this.bus.emit('actuator.resume', {})
  }

  abort(reason = 'user') {
    this.aborted = true
    this.backend.releaseAll().catch(() => {})
    this.bus.emit('actuator.abort', { reason })
  }

  isPaused() { return this.paused }
  isAborted() { return this.aborted }

  async execute(action: Action): Promise<void> {
    if (this.aborted) return
    if (this.paused) return
    if (action.kind === 'abort') { this.abort(action.reason); return }
    if (!(await this.isGameFocused())) return

    const start = this.clock.now()
    try {
      switch (action.kind) {
        case 'press':
          await this.maybeJitter()
          await this.backend.sendKey(action.key, action.holdMs ?? 0)
          break
        case 'combo':
          await this.backend.sendCombo(action.keys, action.interKeyMs ?? 30)
          break
        case 'move':
          await this.backend.sendMove(action.direction, action.ms)
          break
        case 'wait':
          await this.clock.sleep(action.ms)
          break
      }
      this.bus.emit('action.executed', {
        action, backend: 'foreground-nut', timing: this.clock.now() - start,
      })
    } catch (err) {
      // swallow; logging handled by orchestrator
    }
  }

  private async maybeJitter() {
    if (this.jitter <= 0) return
    const ms = Math.floor(Math.random() * this.jitter)
    if (ms > 0) await this.clock.sleep(ms)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/actuator.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/core/actuator.ts tests/unit/actuator.test.ts
git commit -m "feat(core): Actuator with focus-gate, pause/resume/abort"
```

---

## Phase 3 — ActionScheduler + Hotkeys + Reflex

### Task 3.1: ActionScheduler

**Files:**
- Create: `src/core/scheduler.ts`
- Test: `tests/unit/scheduler.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/unit/scheduler.test.ts
import { describe, it, expect, vi } from 'vitest'
import { ActionScheduler } from '@/core/scheduler'
import type { Action } from '@/core/types'
import { FakeClock } from '@/core/clock'

function recorder() {
  const got: Action[] = []
  return { execute: vi.fn(async (a: Action) => { got.push(a) }), got }
}

describe('ActionScheduler', () => {
  it('executes higher-priority action first', async () => {
    const r = recorder()
    const c = new FakeClock(0)
    const s = new ActionScheduler({ execute: r.execute, clock: c })
    s.submit('routine', { kind: 'press', key: 'ctrl' }, 'routine')
    s.submit('reflex',  { kind: 'press', key: 'page_up' }, 'emergency')
    await s.tick()
    expect(r.got[0]).toEqual({ kind: 'press', key: 'page_up' })
  })

  it('dedupes same press within cooldown for same source', async () => {
    const r = recorder()
    const c = new FakeClock(0)
    const s = new ActionScheduler({ execute: r.execute, clock: c, perKeyCooldownMs: 500 })
    s.submit('routine', { kind: 'press', key: 'ctrl' }, 'routine')
    s.submit('routine', { kind: 'press', key: 'ctrl' }, 'routine')
    await s.tick()
    expect(r.got.length).toBe(1)
  })

  it('clear(source) drops only that source', async () => {
    const r = recorder()
    const c = new FakeClock(0)
    const s = new ActionScheduler({ execute: r.execute, clock: c })
    s.submit('routine', { kind: 'press', key: 'ctrl' }, 'routine')
    s.submit('reflex',  { kind: 'press', key: 'page_up' }, 'emergency')
    s.clear('routine')
    await s.tick()
    expect(r.got.map(a => (a as { key: string }).key)).toEqual(['page_up'])
  })

  it('rate-limits global submissions', async () => {
    const r = recorder()
    const c = new FakeClock(0)
    const s = new ActionScheduler({ execute: r.execute, clock: c, globalRateLimitPerSec: 5 })
    for (let i = 0; i < 20; i++) {
      s.submit('routine', { kind: 'press', key: `k${i}` }, 'routine')
    }
    await s.tick()
    expect(r.got.length).toBeLessThanOrEqual(5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/scheduler.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement scheduler.ts**

```ts
// src/core/scheduler.ts
import { PRIORITY_ORDER } from './types'
import type { Action, ActionSource, ActionPriority } from './types'
import type { Clock } from './clock'

export interface SchedulerOpts {
  execute: (a: Action) => Promise<void>
  clock: Clock
  perKeyCooldownMs?: number
  globalRateLimitPerSec?: number
}

interface Entry { source: ActionSource; action: Action; priority: ActionPriority; submittedAt: number }

export class ActionScheduler {
  private queue: Entry[] = []
  private execute: (a: Action) => Promise<void>
  private clock: Clock
  private perKeyCooldownMs: number
  private globalRate: number
  private lastKeyAt = new Map<string, number>()    // key="<source>:<press_key>"
  private windowStart = 0
  private windowCount = 0

  constructor(opts: SchedulerOpts) {
    this.execute = opts.execute
    this.clock = opts.clock
    this.perKeyCooldownMs = opts.perKeyCooldownMs ?? 200
    this.globalRate = opts.globalRateLimitPerSec ?? 20
  }

  submit(source: ActionSource, action: Action, priority: ActionPriority) {
    if (action.kind === 'press') {
      const k = `${source}:${action.key}`
      const last = this.lastKeyAt.get(k) ?? -Infinity
      if (this.clock.now() - last < this.perKeyCooldownMs) return  // dedupe
      this.lastKeyAt.set(k, this.clock.now())
    }
    this.queue.push({ source, action, priority, submittedAt: this.clock.now() })
  }

  clear(source?: ActionSource) {
    if (!source) this.queue = []
    else this.queue = this.queue.filter(e => e.source !== source)
  }

  async tick(): Promise<void> {
    this.queue.sort((a, b) => {
      const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
      return p !== 0 ? p : a.submittedAt - b.submittedAt
    })
    while (this.queue.length) {
      // global rate-limit window (1s)
      const now = this.clock.now()
      if (now - this.windowStart >= 1000) {
        this.windowStart = now
        this.windowCount = 0
      }
      if (this.windowCount >= this.globalRate) break
      const entry = this.queue.shift()!
      this.windowCount++
      await this.execute(entry.action)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/scheduler.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler.ts tests/unit/scheduler.test.ts
git commit -m "feat(core): ActionScheduler with priority, dedupe, rate-limit"
```

### Task 3.2: Global hotkey listener (F10/F12/F9)

**Files:**
- Create: `src/core/hotkeys.ts`

- [ ] **Step 1: Implement hotkeys.ts**

```ts
// src/core/hotkeys.ts
import { GlobalKeyboardListener } from 'node-global-key-listener'

export interface HotkeyHandlers {
  onPauseToggle: () => void
  onAbort: () => void
  onMark?: () => void
}

export class HotkeyService {
  private listener: GlobalKeyboardListener
  private handlers: HotkeyHandlers

  constructor(handlers: HotkeyHandlers) {
    this.listener = new GlobalKeyboardListener()
    this.handlers = handlers
  }

  start(): void {
    this.listener.addListener(e => {
      if (e.state !== 'DOWN') return
      if (e.name === 'F10') this.handlers.onPauseToggle()
      else if (e.name === 'F12') this.handlers.onAbort()
      else if (e.name === 'F9' && this.handlers.onMark) this.handlers.onMark()
    })
  }

  stop(): void { this.listener.kill() }
}
```

- [ ] **Step 2: Manual smoke test**

Run: `pnpm tsx -e "import('./src/core/hotkeys.ts').then(({HotkeyService}) => { const h = new HotkeyService({ onPauseToggle: () => console.log('PAUSE'), onAbort: () => { console.log('ABORT'); process.exit(0) } }); h.start(); console.log('Press F10 to test, F12 to exit') })"`
Expected: pressing F10 logs PAUSE; F12 logs ABORT and exits.

- [ ] **Step 3: Commit**

```bash
git add src/core/hotkeys.ts
git commit -m "feat(core): global hotkeys F10/F12/F9"
```

### Task 3.3: Reflex pixel-sampler

**Files:**
- Create: `src/reflex/pixel-sampler.ts`
- Test: `tests/unit/reflex.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/unit/reflex.test.ts
import { describe, it, expect } from 'vitest'
import { redPixelRatio, bluePixelRatio, greenPixelRatio } from '@/reflex/pixel-sampler'

function makeBgra(pixels: [number, number, number][]): Buffer {
  // sharp raw is RGBA in native channel order; we treat as RGBA below.
  const buf = Buffer.alloc(pixels.length * 4)
  pixels.forEach(([r, g, b], i) => {
    buf[i * 4 + 0] = r
    buf[i * 4 + 1] = g
    buf[i * 4 + 2] = b
    buf[i * 4 + 3] = 255
  })
  return buf
}

describe('pixel ratios', () => {
  it('redPixelRatio counts red-dominant pixels', () => {
    const buf = makeBgra([[255, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]])
    expect(redPixelRatio(buf)).toBeCloseTo(0.5, 2)
  })
  it('bluePixelRatio counts blue-dominant pixels', () => {
    const buf = makeBgra([[0, 0, 255], [0, 0, 255], [0, 0, 255], [0, 255, 0]])
    expect(bluePixelRatio(buf)).toBeCloseTo(0.75, 2)
  })
  it('greenPixelRatio counts green-dominant pixels', () => {
    const buf = makeBgra([[0, 255, 0], [255, 0, 0]])
    expect(greenPixelRatio(buf)).toBeCloseTo(0.5, 2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/reflex.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement pixel-sampler.ts**

```ts
// src/reflex/pixel-sampler.ts
export function redPixelRatio(rgba: Buffer): number {
  const px = rgba.length / 4
  let red = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
    if (r > 150 && g < 80 && b < 80) red++
  }
  return red / px
}

export function bluePixelRatio(rgba: Buffer): number {
  const px = rgba.length / 4
  let blue = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
    if (b > 150 && r < 80 && g < 100) blue++
  }
  return blue / px
}

export function greenPixelRatio(rgba: Buffer): number {
  const px = rgba.length / 4
  let green = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
    if (g > 150 && r < 80 && b < 80) green++
  }
  return green / px
}

export type Metric = 'red_pixel_ratio' | 'blue_pixel_ratio' | 'green_pixel_ratio'

export function metricValue(m: Metric, rgba: Buffer): number {
  switch (m) {
    case 'red_pixel_ratio':   return redPixelRatio(rgba)
    case 'blue_pixel_ratio':  return bluePixelRatio(rgba)
    case 'green_pixel_ratio': return greenPixelRatio(rgba)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/reflex.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/reflex/pixel-sampler.ts tests/unit/reflex.test.ts
git commit -m "feat(reflex): pixel-ratio metrics for HP/MP detection"
```

### Task 3.4: Reflex worker — fires emergency actions

**Files:**
- Modify: `src/reflex/pixel-sampler.ts` (add `ReflexWorker`)
- Test: `tests/unit/reflex-worker.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/unit/reflex-worker.test.ts
import { describe, it, expect, vi } from 'vitest'
import { ReflexWorker } from '@/reflex/pixel-sampler'
import { FakeClock } from '@/core/clock'

function lowHpRegion(): Buffer {
  // Buffer of 100 px, none red — simulates empty bar
  return Buffer.alloc(100 * 4, 0)
}
function fullHpRegion(): Buffer {
  const b = Buffer.alloc(100 * 4)
  for (let i = 0; i < 100; i++) {
    b[i * 4] = 255; b[i * 4 + 1] = 0; b[i * 4 + 2] = 0; b[i * 4 + 3] = 255
  }
  return b
}

describe('ReflexWorker', () => {
  it('fires action when below threshold + cooldown allows', async () => {
    const submits: string[] = []
    const c = new FakeClock(0)
    const w = new ReflexWorker({
      clock: c,
      submit: (a) => submits.push((a as { key: string }).key),
      checks: [
        { region: 'hp', metric: 'red_pixel_ratio', below: 0.30, cooldownMs: 800,
          action: { kind: 'press', key: 'page_up' } },
      ],
      sample: async (region) => region === 'hp' ? lowHpRegion() : Buffer.alloc(0),
    })
    await w.tick()
    expect(submits).toEqual(['page_up'])
  })

  it('does not fire when above threshold', async () => {
    const submits: string[] = []
    const c = new FakeClock(0)
    const w = new ReflexWorker({
      clock: c,
      submit: (a) => submits.push((a as { key: string }).key),
      checks: [
        { region: 'hp', metric: 'red_pixel_ratio', below: 0.30, cooldownMs: 800,
          action: { kind: 'press', key: 'page_up' } },
      ],
      sample: async () => fullHpRegion(),
    })
    await w.tick()
    expect(submits).toEqual([])
  })

  it('respects cooldown', async () => {
    const submits: string[] = []
    const c = new FakeClock(0)
    const w = new ReflexWorker({
      clock: c,
      submit: (a) => submits.push((a as { key: string }).key),
      checks: [
        { region: 'hp', metric: 'red_pixel_ratio', below: 0.30, cooldownMs: 800,
          action: { kind: 'press', key: 'page_up' } },
      ],
      sample: async () => lowHpRegion(),
    })
    await w.tick()
    await w.tick()
    expect(submits.length).toBe(1)
    c.tick(900)
    await w.tick()
    expect(submits.length).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/reflex-worker.test.ts`
Expected: fail — `ReflexWorker` not exported.

- [ ] **Step 3: Append ReflexWorker to pixel-sampler.ts**

```ts
// append to src/reflex/pixel-sampler.ts
import type { Action } from '@/core/types'
import type { Clock } from '@/core/clock'

export interface ReflexCheck {
  region: string
  metric: Metric
  below: number
  cooldownMs: number
  action: Action
}

export interface ReflexWorkerOpts {
  clock: Clock
  submit: (a: Action) => void
  checks: ReflexCheck[]
  sample: (region: string) => Promise<Buffer>
}

export class ReflexWorker {
  private clock: Clock
  private submit: (a: Action) => void
  private checks: ReflexCheck[]
  private sample: (region: string) => Promise<Buffer>
  private lastFiredAt = new Map<string, number>()
  private vitals: Record<string, number> = { hp: 1, mp: 1 }

  constructor(opts: ReflexWorkerOpts) {
    this.clock = opts.clock
    this.submit = opts.submit
    this.checks = opts.checks
    this.sample = opts.sample
  }

  current(): { hp: number; mp: number } {
    return { hp: this.vitals.hp ?? 1, mp: this.vitals.mp ?? 1 }
  }

  async tick(): Promise<void> {
    for (const c of this.checks) {
      const buf = await this.sample(c.region)
      if (buf.length === 0) continue
      const v = metricValue(c.metric, buf)
      this.vitals[c.region] = v
      if (v >= c.below) continue
      const last = this.lastFiredAt.get(c.region) ?? -Infinity
      if (this.clock.now() - last < c.cooldownMs) continue
      this.lastFiredAt.set(c.region, this.clock.now())
      this.submit(c.action)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/reflex-worker.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/reflex/pixel-sampler.ts tests/unit/reflex-worker.test.ts
git commit -m "feat(reflex): ReflexWorker fires emergency actions on threshold"
```

---

## Phase 4 — Perception (YOLO + NMS + State Builder)

### Task 4.1: NMS pure function

**Files:**
- Create: `src/perception/nms.ts`
- Test: `tests/unit/nms.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/unit/nms.test.ts
import { describe, it, expect } from 'vitest'
import { nonMaxSuppression } from '@/perception/nms'
import type { Detection } from '@/core/types'

describe('nonMaxSuppression', () => {
  it('removes overlapping lower-confidence boxes', () => {
    const dets: Detection[] = [
      { class: 'mob', bbox: [0, 0, 100, 100], confidence: 0.9 },
      { class: 'mob', bbox: [10, 10, 100, 100], confidence: 0.5 },
      { class: 'mob', bbox: [500, 500, 50, 50], confidence: 0.7 },
    ]
    const out = nonMaxSuppression(dets, 0.5)
    expect(out.length).toBe(2)
    expect(out.map(d => d.confidence)).toContain(0.9)
    expect(out.map(d => d.confidence)).toContain(0.7)
  })

  it('respects per-class boundary', () => {
    const dets: Detection[] = [
      { class: 'mob',    bbox: [0, 0, 100, 100], confidence: 0.9 },
      { class: 'player', bbox: [0, 0, 100, 100], confidence: 0.95 },
    ]
    const out = nonMaxSuppression(dets, 0.5)
    expect(out.length).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/nms.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement nms.ts**

```ts
// src/perception/nms.ts
import type { Detection } from '@/core/types'

function iou(a: Detection['bbox'], b: Detection['bbox']): number {
  const [ax, ay, aw, ah] = a
  const [bx, by, bw, bh] = b
  const x1 = Math.max(ax, bx), y1 = Math.max(ay, by)
  const x2 = Math.min(ax + aw, bx + bw), y2 = Math.min(ay + ah, by + bh)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = aw * ah + bw * bh - inter
  return union > 0 ? inter / union : 0
}

export function nonMaxSuppression(dets: Detection[], iouThresh = 0.5): Detection[] {
  const byClass = new Map<string, Detection[]>()
  for (const d of dets) {
    if (!byClass.has(d.class)) byClass.set(d.class, [])
    byClass.get(d.class)!.push(d)
  }
  const out: Detection[] = []
  for (const list of byClass.values()) {
    list.sort((a, b) => b.confidence - a.confidence)
    const kept: Detection[] = []
    for (const d of list) {
      if (kept.every(k => iou(k.bbox, d.bbox) < iouThresh)) kept.push(d)
    }
    out.push(...kept)
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/nms.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/perception/nms.ts tests/unit/nms.test.ts
git commit -m "feat(perception): NMS for YOLO detections"
```

### Task 4.2: State Builder pure function

**Files:**
- Create: `src/perception/state-builder.ts`
- Test: `tests/unit/state-builder.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/unit/state-builder.test.ts
import { describe, it, expect } from 'vitest'
import { buildGameState } from '@/perception/state-builder'
import type { PerceptionFrame } from '@/core/types'

const f: PerceptionFrame = {
  timestamp: 1000,
  detections: [
    { class: 'player', bbox: [500, 320, 40, 60], confidence: 0.98 },
    { class: 'mob_generic', bbox: [420, 300, 80, 60], confidence: 0.91 },
    { class: 'mob_generic', bbox: [650, 310, 80, 60], confidence: 0.87 },
    { class: 'rune', bbox: [1750, 100, 48, 48], confidence: 0.95 },
  ],
  screenshotMeta: { width: 1920, height: 1080 },
  overallConfidence: 0.93,
}

const minimapPos = { x: 100, y: 80 }
const bounds = { x: [25, 205] as [number, number], y: [40, 130] as [number, number] }

describe('buildGameState', () => {
  it('uses Reflex vitals (not YOLO) for hp/mp', () => {
    const s = buildGameState(f, { hp: 0.42, mp: 0.78 }, minimapPos, bounds)
    expect(s.player.hp).toBe(0.42)
    expect(s.player.mp).toBe(0.78)
  })

  it('player.pos comes from minimap (canonical)', () => {
    const s = buildGameState(f, { hp: 1, mp: 1 }, minimapPos, bounds)
    expect(s.player.pos).toEqual(minimapPos)
  })

  it('player.screenPos comes from YOLO bbox center', () => {
    const s = buildGameState(f, { hp: 1, mp: 1 }, minimapPos, bounds)
    expect(s.player.screenPos).toEqual({ x: 520, y: 350 })
  })

  it('builds enemy list with distance from screen player position', () => {
    const s = buildGameState(f, { hp: 1, mp: 1 }, minimapPos, bounds)
    expect(s.enemies.length).toBe(2)
    expect(s.enemies[0].distancePx).toBeLessThan(s.enemies[1].distancePx)
  })

  it('flags rune when rune detection >= 0.75', () => {
    const s = buildGameState(f, { hp: 1, mp: 1 }, minimapPos, bounds)
    expect(s.flags.runeActive).toBe(true)
  })

  it('flags outOfBounds when minimap pos exits bounds + margin', () => {
    const s = buildGameState(f, { hp: 1, mp: 1 }, { x: 220, y: 80 }, bounds, 10)
    expect(s.flags.outOfBounds).toBe(true)
  })

  it('player.pos null when minimapPos null', () => {
    const s = buildGameState(f, { hp: 1, mp: 1 }, null, bounds)
    expect(s.player.pos).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/state-builder.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement state-builder.ts**

```ts
// src/perception/state-builder.ts
import type { PerceptionFrame, GameState, EnemyState, Vec2 } from '@/core/types'

const RUNE_THRESHOLD = 0.75

export interface Bounds { x: [number, number]; y: [number, number] }

function bboxCenter(b: [number, number, number, number]): Vec2 {
  return { x: b[0] + b[2] / 2, y: b[1] + b[3] / 2 }
}

function dist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x, dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

function outOfBounds(p: Vec2 | null, b: Bounds | null, margin: number): boolean {
  if (!p || !b) return false
  return p.x < b.x[0] - margin || p.x > b.x[1] + margin
      || p.y < b.y[0] - margin || p.y > b.y[1] + margin
}

export function buildGameState(
  frame: PerceptionFrame,
  vitals: { hp: number; mp: number },
  minimapPos: Vec2 | null,
  bounds: Bounds | null = null,
  boundsMargin: number = 10,
): GameState {
  const players = frame.detections.filter(d => d.class === 'player')
                                  .sort((a, b) => b.confidence - a.confidence)
  const screenPos = players.length ? bboxCenter(players[0].bbox) : null

  const enemies: EnemyState[] = frame.detections
    .filter(d => d.class.startsWith('mob'))
    .map(d => {
      const pos = bboxCenter(d.bbox)
      return {
        type: d.class,
        pos,
        distancePx: screenPos ? dist(pos, screenPos) : Infinity,
      }
    })
    .sort((a, b) => a.distancePx - b.distancePx)

  const runeActive = frame.detections.some(d => d.class === 'rune' && d.confidence >= RUNE_THRESHOLD)

  return {
    timestamp: frame.timestamp,
    player: { pos: minimapPos, screenPos, hp: vitals.hp, mp: vitals.mp },
    enemies,
    flags: { runeActive, outOfBounds: outOfBounds(minimapPos, bounds, boundsMargin) },
    popup: null,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/state-builder.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```ts
git add src/perception/state-builder.ts tests/unit/state-builder.test.ts
git commit -m "feat(perception): pure state-builder PerceptionFrame→GameState"
```

### Task 4.3: YOLO ONNX wrapper

**Files:**
- Create: `src/perception/yolo.ts`
- Test: `tests/integration/yolo.test.ts` (smoke test, gated)

- [ ] **Step 1: Implement yolo.ts**

```ts
// src/perception/yolo.ts
import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import { nonMaxSuppression } from './nms'
import type { Detection, PerceptionFrame } from '@/core/types'

export interface YoloOpts {
  modelPath: string
  inputSize?: number
  confidenceThreshold?: number
  classes: string[]
}

export class YoloPerception {
  private session: ort.InferenceSession | null = null
  private opts: Required<Omit<YoloOpts, 'modelPath' | 'classes'>> & { modelPath: string; classes: string[] }

  constructor(opts: YoloOpts) {
    this.opts = {
      modelPath: opts.modelPath,
      inputSize: opts.inputSize ?? 640,
      confidenceThreshold: opts.confidenceThreshold ?? 0.6,
      classes: opts.classes,
    }
  }

  async load(): Promise<void> {
    this.session = await ort.InferenceSession.create(this.opts.modelPath)
  }

  async run(rawScreenshot: Buffer, screenW: number, screenH: number): Promise<PerceptionFrame> {
    if (!this.session) throw new Error('YoloPerception: load() not called')
    const sz = this.opts.inputSize
    const resized = await sharp(rawScreenshot, { raw: { width: screenW, height: screenH, channels: 4 } })
      .removeAlpha()
      .resize(sz, sz, { fit: 'fill' })
      .raw()
      .toBuffer()
    // Convert HWC to CHW float32
    const chw = new Float32Array(3 * sz * sz)
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        const i = (y * sz + x) * 3
        chw[0 * sz * sz + y * sz + x] = resized[i + 0] / 255
        chw[1 * sz * sz + y * sz + x] = resized[i + 1] / 255
        chw[2 * sz * sz + y * sz + x] = resized[i + 2] / 255
      }
    }
    const tensor = new ort.Tensor('float32', chw, [1, 3, sz, sz])
    const inputName = this.session.inputNames[0]
    const out = await this.session.run({ [inputName]: tensor })
    const detections = this.parseYoloOutput(out, screenW, screenH)
    return {
      timestamp: Date.now(),
      detections: nonMaxSuppression(detections, 0.5),
      screenshotMeta: { width: screenW, height: screenH },
      overallConfidence: detections.reduce((m, d) => Math.max(m, d.confidence), 0),
    }
  }

  private parseYoloOutput(out: ort.InferenceSession.OnnxValueMapType, screenW: number, screenH: number): Detection[] {
    // YOLOv8 output: [1, num_classes+4, N]
    const tensor = out[Object.keys(out)[0]] as ort.Tensor
    const data = tensor.data as Float32Array
    const dims = tensor.dims
    const numAttrs = dims[1]                   // 4 + classes
    const N = dims[2]
    const numClasses = numAttrs - 4
    const sz = this.opts.inputSize
    const sx = screenW / sz, sy = screenH / sz
    const dets: Detection[] = []
    for (let i = 0; i < N; i++) {
      const cx = data[0 * N + i], cy = data[1 * N + i], w = data[2 * N + i], h = data[3 * N + i]
      let bestC = -1, bestP = 0
      for (let c = 0; c < numClasses; c++) {
        const p = data[(4 + c) * N + i]
        if (p > bestP) { bestP = p; bestC = c }
      }
      if (bestP < this.opts.confidenceThreshold) continue
      const x = (cx - w / 2) * sx, y = (cy - h / 2) * sy
      dets.push({
        class: this.opts.classes[bestC] ?? `class_${bestC}`,
        bbox: [x, y, w * sx, h * sy],
        confidence: bestP,
      })
    }
    return dets
  }
}
```

- [ ] **Step 2: Write integration test (gated on model file presence)**

```ts
// tests/integration/yolo.test.ts
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { YoloPerception } from '@/perception/yolo'

const MODEL = 'models/yolov8n-maplestory.onnx'

describe.skipIf(!existsSync(MODEL))('YoloPerception integration', () => {
  it('loads ONNX model', async () => {
    const y = new YoloPerception({ modelPath: MODEL, classes: ['player','mob_generic','rune','portal'] })
    await y.load()
    expect(true).toBe(true)
  })
})
```

- [ ] **Step 3: Run test (skipped if no model)**

Run: `pnpm test tests/integration/yolo.test.ts`
Expected: skipped (model not present yet).

- [ ] **Step 4: Commit**

```bash
git add src/perception/yolo.ts tests/integration/yolo.test.ts
git commit -m "feat(perception): YOLOv8 ONNX wrapper"
```

---

## Phase 4.5 — Minimap Sampler + Bounds

The minimap is the canonical spatial coordinate system. Movement primitives, `state.player.pos`, and bounds checks all reference minimap coords, NOT screen coords.

### Task 4.5.1: Minimap player-dot sampler

**Files:**
- Create: `src/perception/minimap.ts`
- Test: `tests/unit/minimap.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/minimap.test.ts
import { describe, it, expect } from 'vitest'
import { findPlayerDot } from '@/perception/minimap'

function makeRgba(w: number, h: number, dot: { x: number; y: number; rgb: [number, number, number] } | null): Buffer {
  const buf = Buffer.alloc(w * h * 4, 0)
  if (dot) {
    // 3x3 dot
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = dot.x + dx, y = dot.y + dy
        if (x < 0 || y < 0 || x >= w || y >= h) continue
        const i = (y * w + x) * 4
        buf[i + 0] = dot.rgb[0]; buf[i + 1] = dot.rgb[1]; buf[i + 2] = dot.rgb[2]; buf[i + 3] = 255
      }
    }
  }
  return buf
}

describe('findPlayerDot', () => {
  it('finds yellow dot location', () => {
    const buf = makeRgba(80, 60, { x: 30, y: 20, rgb: [240, 220, 60] })
    const pos = findPlayerDot(buf, 80, 60, { rgb: [240, 220, 60], tolerance: 30 })
    expect(pos).not.toBeNull()
    expect(pos!.x).toBeCloseTo(30, 0)
    expect(pos!.y).toBeCloseTo(20, 0)
  })

  it('returns null when no matching dot', () => {
    const buf = makeRgba(80, 60, null)
    const pos = findPlayerDot(buf, 80, 60, { rgb: [240, 220, 60], tolerance: 10 })
    expect(pos).toBeNull()
  })

  it('ignores pixels outside tolerance', () => {
    const buf = makeRgba(80, 60, { x: 10, y: 10, rgb: [10, 10, 10] })   // black
    const pos = findPlayerDot(buf, 80, 60, { rgb: [240, 220, 60], tolerance: 30 })
    expect(pos).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/minimap.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement minimap.ts**

```ts
// src/perception/minimap.ts
import type { Vec2 } from '@/core/types'

export interface DotMatcher {
  rgb: [number, number, number]
  tolerance: number              // sum-of-channel-deltas threshold
}

export function findPlayerDot(rgba: Buffer, w: number, h: number, m: DotMatcher): Vec2 | null {
  let sumX = 0, sumY = 0, count = 0
  const [tr, tg, tb] = m.rgb
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const dr = Math.abs(rgba[i] - tr)
      const dg = Math.abs(rgba[i + 1] - tg)
      const db = Math.abs(rgba[i + 2] - tb)
      if (dr + dg + db <= m.tolerance) { sumX += x; sumY += y; count++ }
    }
  }
  if (count === 0) return null
  return { x: sumX / count, y: sumY / count }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/minimap.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/perception/minimap.ts tests/unit/minimap.test.ts
git commit -m "feat(perception): minimap player-dot sampler"
```

### Task 4.5.2: MinimapSampler module (capture + crop + findDot)

**Files:**
- Modify: `src/perception/minimap.ts` (add `MinimapSampler`)
- Test: `tests/unit/minimap-sampler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/minimap-sampler.test.ts
import { describe, it, expect, vi } from 'vitest'
import { MinimapSampler } from '@/perception/minimap'

describe('MinimapSampler', () => {
  it('returns position when capture provides matching pixels', async () => {
    const w = 80, h = 60
    const buf = Buffer.alloc(w * h * 4, 0)
    // 3x3 yellow dot at (30,20)
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const i = ((20 + dy) * w + (30 + dx)) * 4
      buf[i] = 240; buf[i + 1] = 220; buf[i + 2] = 60; buf[i + 3] = 255
    }
    const captureRegion = vi.fn(async () => buf)
    const s = new MinimapSampler({
      captureRegion, region: { x: 0, y: 0, w, h },
      matcher: { rgb: [240, 220, 60], tolerance: 30 },
    })
    const pos = await s.sample()
    expect(pos).not.toBeNull()
    expect(pos!.x).toBeCloseTo(30, 0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/minimap-sampler.test.ts`
Expected: fail — `MinimapSampler` not exported.

- [ ] **Step 3: Append MinimapSampler to minimap.ts**

```ts
// append to src/perception/minimap.ts
import type { Rect } from '@/core/types'

export interface MinimapSamplerOpts {
  captureRegion: (r: Rect) => Promise<Buffer>
  region: Rect
  matcher: DotMatcher
}

export class MinimapSampler {
  constructor(private opts: MinimapSamplerOpts) {}

  async sample(): Promise<Vec2 | null> {
    const buf = await this.opts.captureRegion(this.opts.region)
    return findPlayerDot(buf, this.opts.region.w, this.opts.region.h, this.opts.matcher)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/minimap-sampler.test.ts`
Expected: 1 passing.

- [ ] **Step 5: Commit**

```bash
git add src/perception/minimap.ts tests/unit/minimap-sampler.test.ts
git commit -m "feat(perception): MinimapSampler ties capture + dot finder"
```

---

## Phase 5 — Routine DSL + Runner + Movement Primitives

### Task 5.1: Routine YAML schema (zod)

**Files:**
- Create: `src/routine/schema.ts`
- Test: `tests/unit/routine-schema.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/unit/routine-schema.test.ts
import { describe, it, expect } from 'vitest'
import YAML from 'yaml'
import { Routine } from '@/routine/schema'

const valid = `
game: maplestory
recorded_from: recordings/x
resolution: [1920, 1080]
window_title: "MapleStory"
regions:
  hp:      { x: 820, y: 1000, w: 140, h: 14 }
  mp:      { x: 966, y: 1000, w: 140, h: 14 }
  minimap: { x: 1820, y: 14, w: 80, h: 60 }
reflex:
  - { region: hp, metric: red_pixel_ratio, below: 0.30, cooldown_ms: 800,
      action: { kind: press, key: page_up } }
perception:
  model: yolov8n-maplestory
  fps: 8
  classes: [player, mob_generic, rune, portal]
  confidence_threshold: 0.6
rotation:
  - { when: 'mobs_in_range(300) >= 1', action: { kind: press, key: ctrl }, cooldown_ms: 500 }
  - { every: 30s, action: { kind: press, key: shift } }
movement:
  primitives:
    - { op: walk_to_x, x: 30 }
  loop: true
stop_condition:
  or:
    - duration: 2h
    - out_of_bounds: { margin: 10 }
bounds:
  x: [25, 205]
  y: [40, 130]
minimap_player_color:
  rgb: [240, 220, 60]
  tolerance: 30
`

describe('Routine schema', () => {
  it('accepts valid YAML', () => {
    const obj = YAML.parse(valid)
    expect(() => Routine.parse(obj)).not.toThrow()
  })
  it('rejects missing regions.hp', () => {
    const obj = YAML.parse(valid)
    delete obj.regions.hp
    expect(() => Routine.parse(obj)).toThrow()
  })
  it('rejects unknown rotation rule', () => {
    const obj = YAML.parse(valid)
    obj.rotation.push({ bogus: 1 })
    expect(() => Routine.parse(obj)).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/routine-schema.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement schema.ts**

```ts
// src/routine/schema.ts
import { z } from 'zod'
import { Action, Rect } from '@/core/types'

export const ReflexEntry = z.object({
  region: z.string(),
  metric: z.enum(['red_pixel_ratio', 'blue_pixel_ratio', 'green_pixel_ratio']),
  below: z.number().min(0).max(1),
  cooldown_ms: z.number().int().min(0),
  action: Action,
})

export const PerceptionConfig = z.object({
  model: z.string(),
  fps: z.number().min(1).max(30),
  classes: z.array(z.string()).min(1),
  confidence_threshold: z.number().min(0).max(1),
})

export const RotationRule = z.union([
  z.object({
    when: z.string(),
    action: Action,
    cooldown_ms: z.number().int().min(0).optional(),
  }),
  z.object({
    every: z.string(),                       // e.g. "30s", "3m"
    action: Action,
  }),
])

export const MovementPrimitive = z.union([
  z.object({ op: z.literal('walk_to_x'),   x: z.number() }),
  z.object({ op: z.literal('jump_left'),   holdMs: z.number().optional() }),
  z.object({ op: z.literal('jump_right'),  holdMs: z.number().optional() }),
  z.object({ op: z.literal('drop_down') }),
  z.object({ op: z.literal('wait'),        ms: z.number() }),
])

export const Movement = z.object({
  primitives: z.array(MovementPrimitive),
  loop: z.boolean().default(true),
  pause_while_attacking: z.boolean().default(true),
})

export const StopCondition = z.object({
  or: z.array(z.union([
    z.object({ duration: z.string() }),
    z.object({ hp_persist_below: z.object({ value: z.number(), seconds: z.number() }) }),
    z.object({ popup_detected: z.boolean() }),
    z.object({ out_of_bounds: z.object({ margin: z.number() }) }),
  ])),
})

export const Bounds = z.object({
  x: z.tuple([z.number(), z.number()]),
  y: z.tuple([z.number(), z.number()]),
})

export const MinimapPlayerColor = z.object({
  rgb: z.tuple([z.number(), z.number(), z.number()]),
  tolerance: z.number(),
})

export const Routine = z.object({
  game: z.literal('maplestory'),
  recorded_from: z.string().optional(),
  resolution: z.tuple([z.number(), z.number()]),
  window_title: z.string(),
  unreviewed: z.boolean().optional(),
  regions: z.object({
    hp: Rect, mp: Rect, minimap: Rect,
    popup: Rect.optional(),
  }).passthrough(),
  reflex: z.array(ReflexEntry),
  perception: PerceptionConfig,
  rotation: z.array(RotationRule),
  movement: Movement,
  stop_condition: StopCondition.optional(),
  bounds: Bounds.optional(),
  minimap_player_color: MinimapPlayerColor.optional(),
})
export type Routine = z.infer<typeof Routine>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/routine-schema.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/routine/schema.ts tests/unit/routine-schema.test.ts
git commit -m "feat(routine): zod schema for routine YAML"
```

### Task 5.2: `when` DSL parser (whitelist)

**Files:**
- Create: `src/routine/dsl.ts`
- Test: `tests/unit/dsl.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/unit/dsl.test.ts
import { describe, it, expect } from 'vitest'
import { compileWhen } from '@/routine/dsl'
import type { GameState } from '@/core/types'

const state: GameState = {
  timestamp: 0,
  player: { pos: { x: 100, y: 100 }, screenPos: { x: 100, y: 100 }, hp: 0.5, mp: 0.4 },
  enemies: [
    { type: 'mob_generic', pos: { x: 250, y: 100 }, distancePx: 150 },
    { type: 'mob_generic', pos: { x: 600, y: 100 }, distancePx: 500 },
  ],
  flags: { runeActive: false, outOfBounds: false },
  popup: null,
}

describe('compileWhen', () => {
  it('mobs_in_range counts within radius', () => {
    expect(compileWhen('mobs_in_range(200) >= 1')(state)).toBe(true)
    expect(compileWhen('mobs_in_range(200) >= 2')(state)).toBe(false)
  })
  it('hp comparator', () => {
    expect(compileWhen('hp < 0.6')(state)).toBe(true)
    expect(compileWhen('mp < 0.3')(state)).toBe(false)
  })
  it('rune_active boolean', () => {
    expect(compileWhen('rune_active')(state)).toBe(false)
  })
  it('rejects arbitrary JS', () => {
    expect(() => compileWhen('process.exit(0)')).toThrow()
    expect(() => compileWhen('require("fs")')).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/dsl.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement dsl.ts**

```ts
// src/routine/dsl.ts
import type { GameState } from '@/core/types'

export type Predicate = (state: GameState) => boolean

const ALLOWED_FN = ['mobs_in_range', 'buff_expired', 'stuck_seconds']
const ALLOWED_VAR = ['hp', 'mp', 'rune_active']

const TOKEN_RE = /^\s*(?:(\d+(?:\.\d+)?)|(<=|>=|!=|==|<|>)|(&&|\|\|)|(\(|\))|([a-z_]+))/

interface Tok { kind: 'num' | 'cmp' | 'logic' | 'paren' | 'ident'; value: string }

function tokenize(input: string): Tok[] {
  const toks: Tok[] = []
  let s = input
  while (s.trim().length) {
    const m = TOKEN_RE.exec(s)
    if (!m) throw new Error(`when: invalid token at "${s.slice(0, 20)}"`)
    s = s.slice(m[0].length)
    if (m[1]) toks.push({ kind: 'num',   value: m[1] })
    else if (m[2]) toks.push({ kind: 'cmp',   value: m[2] })
    else if (m[3]) toks.push({ kind: 'logic', value: m[3] })
    else if (m[4]) toks.push({ kind: 'paren', value: m[4] })
    else if (m[5]) toks.push({ kind: 'ident', value: m[5] })
  }
  return toks
}

function validateIdents(toks: Tok[]): void {
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].kind === 'ident') {
      const name = toks[i].value
      const isFn = i + 1 < toks.length && toks[i + 1].kind === 'paren' && toks[i + 1].value === '('
      if (isFn) {
        if (!ALLOWED_FN.includes(name)) throw new Error(`when: function not allowed: ${name}`)
      } else {
        if (!ALLOWED_VAR.includes(name)) throw new Error(`when: identifier not allowed: ${name}`)
      }
    }
  }
}

function evalSrc(src: string, state: GameState): boolean {
  const ctx = {
    hp: state.player.hp,
    mp: state.player.mp,
    rune_active: state.flags.runeActive,
    mobs_in_range: (px: number) => state.enemies.filter(e => e.distancePx <= px).length,
    buff_expired: (_n: string) => false,           // v1: stub; routine-runner tracks buffs
    stuck_seconds: () => 0,                        // v1: stub
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function(...Object.keys(ctx), `return (${src})`)
  return Boolean(fn(...Object.values(ctx)))
}

export function compileWhen(expr: string): Predicate {
  const toks = tokenize(expr)
  validateIdents(toks)
  return (state) => evalSrc(expr, state)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/dsl.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/routine/dsl.ts tests/unit/dsl.test.ts
git commit -m "feat(routine): when DSL parser with whitelist enforcement"
```

### Task 5.3: Movement primitive FSM

**Files:**
- Create: `src/routine/movement.ts`
- Test: `tests/unit/movement.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/unit/movement.test.ts
import { describe, it, expect } from 'vitest'
import { MovementFsm } from '@/routine/movement'
import { FakeClock } from '@/core/clock'
import type { Action } from '@/core/types'
import type { Routine } from '@/routine/schema'

const movement: Routine['movement'] = {
  primitives: [
    { op: 'walk_to_x', x: 30 },
    { op: 'walk_to_x', x: 170 },
  ],
  loop: true,
  pause_while_attacking: true,
}

function actionsFromFsm(fsm: MovementFsm, playerX: number): Action[] {
  const got: Action[] = []
  fsm.tick({ playerX, attacking: false }, a => got.push(a))
  return got
}

describe('MovementFsm', () => {
  it('walks right to reach x=30 from x=0', () => {
    const fsm = new MovementFsm(movement, new FakeClock(0))
    const a = actionsFromFsm(fsm, 0)
    expect(a[0]).toEqual({ kind: 'press', key: 'right', holdMs: 50 })
  })
  it('walks left to reach x=30 from x=200', () => {
    const fsm = new MovementFsm(movement, new FakeClock(0))
    const a = actionsFromFsm(fsm, 200)
    expect(a[0]).toEqual({ kind: 'press', key: 'left', holdMs: 50 })
  })
  it('advances to next primitive when within tolerance', () => {
    const fsm = new MovementFsm(movement, new FakeClock(0))
    actionsFromFsm(fsm, 30)              // primitive 0 done
    const a2 = actionsFromFsm(fsm, 30)   // now heading to 170
    expect(a2[0]).toEqual({ kind: 'press', key: 'right', holdMs: 50 })
  })
  it('emits no action when attacking and pause_while_attacking', () => {
    const fsm = new MovementFsm(movement, new FakeClock(0))
    const got: Action[] = []
    fsm.tick({ playerX: 0, attacking: true }, a => got.push(a))
    expect(got).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/movement.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement movement.ts**

```ts
// src/routine/movement.ts
import type { Action } from '@/core/types'
import type { Routine } from './schema'
import type { Clock } from '@/core/clock'

export interface MovementCtx { playerX: number; attacking: boolean }

const TOLERANCE = 5

export class MovementFsm {
  private idx = 0
  constructor(private movement: Routine['movement'], private _clock: Clock) {}

  tick(ctx: MovementCtx, emit: (a: Action) => void): void {
    if (ctx.attacking && this.movement.pause_while_attacking) return
    const prim = this.movement.primitives[this.idx]
    if (!prim) return
    switch (prim.op) {
      case 'walk_to_x': {
        const delta = prim.x - ctx.playerX
        if (Math.abs(delta) <= TOLERANCE) { this.advance(); return }
        emit({ kind: 'press', key: delta > 0 ? 'right' : 'left', holdMs: 50 })
        return
      }
      case 'jump_left':  emit({ kind: 'combo', keys: ['left',  'alt'], interKeyMs: 30 }); this.advance(); return
      case 'jump_right': emit({ kind: 'combo', keys: ['right', 'alt'], interKeyMs: 30 }); this.advance(); return
      case 'drop_down':  emit({ kind: 'combo', keys: ['down',  'alt'], interKeyMs: 30 }); this.advance(); return
      case 'wait':       emit({ kind: 'wait',  ms: prim.ms }); this.advance(); return
    }
  }

  private advance() {
    this.idx++
    if (this.idx >= this.movement.primitives.length && this.movement.loop) this.idx = 0
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/movement.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/routine/movement.ts tests/unit/movement.test.ts
git commit -m "feat(routine): movement primitive FSM"
```

### Task 5.4: RoutineRunner (rotation + every + movement integration)

**Files:**
- Create: `src/routine/runner.ts`
- Test: `tests/unit/runner.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/unit/runner.test.ts
import { describe, it, expect } from 'vitest'
import { RoutineRunner, parseDuration } from '@/routine/runner'
import { FakeClock } from '@/core/clock'
import type { GameState, Action } from '@/core/types'
import type { Routine } from '@/routine/schema'

const routine: Routine = {
  game: 'maplestory',
  resolution: [1920, 1080],
  window_title: 'MapleStory',
  regions: {
    hp: { x: 0, y: 0, w: 1, h: 1 },
    mp: { x: 0, y: 0, w: 1, h: 1 },
    minimap: { x: 0, y: 0, w: 1, h: 1 },
  },
  reflex: [],
  perception: { model: 'm', fps: 8, classes: ['player'], confidence_threshold: 0.5 },
  rotation: [
    { when: 'mobs_in_range(300) >= 1', action: { kind: 'press', key: 'ctrl' }, cooldown_ms: 500 },
    { every: '30s', action: { kind: 'press', key: 'shift' } },
  ],
  movement: { primitives: [{ op: 'walk_to_x', x: 50 }], loop: true, pause_while_attacking: true },
}

function stateWithMobs(distance: number, playerX = 0): GameState {
  return {
    timestamp: 0,
    player: { pos: { x: playerX, y: 0 }, screenPos: { x: playerX, y: 0 }, hp: 1, mp: 1 },
    enemies: distance >= 0 ? [{ type: 'mob_generic', pos: { x: playerX + distance, y: 0 }, distancePx: distance }] : [],
    flags: { runeActive: false, outOfBounds: false }, popup: null,
  }
}

describe('parseDuration', () => {
  it('parses seconds, minutes, hours', () => {
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('2h')).toBe(7_200_000)
  })
})

describe('RoutineRunner', () => {
  it('fires rotation rule when condition true', () => {
    const c = new FakeClock(0)
    const got: Action[] = []
    const r = new RoutineRunner(routine, c, a => got.push(a))
    r.tick(stateWithMobs(100))
    expect(got.some(a => (a as { key: string }).key === 'ctrl')).toBe(true)
  })

  it('respects rotation cooldown', () => {
    const c = new FakeClock(0)
    const got: Action[] = []
    const r = new RoutineRunner(routine, c, a => got.push(a))
    r.tick(stateWithMobs(100))
    r.tick(stateWithMobs(100))
    expect(got.filter(a => (a as { key: string }).key === 'ctrl').length).toBe(1)
    c.tick(600)
    r.tick(stateWithMobs(100))
    expect(got.filter(a => (a as { key: string }).key === 'ctrl').length).toBe(2)
  })

  it('fires `every` rule on cadence', () => {
    const c = new FakeClock(0)
    const got: Action[] = []
    const r = new RoutineRunner(routine, c, a => got.push(a))
    r.tick(stateWithMobs(-1))
    expect(got.some(a => (a as { key: string }).key === 'shift')).toBe(false)
    c.tick(31_000)
    r.tick(stateWithMobs(-1))
    expect(got.some(a => (a as { key: string }).key === 'shift')).toBe(true)
  })

  it('emits movement when no mob in range', () => {
    const c = new FakeClock(0)
    const got: Action[] = []
    const r = new RoutineRunner(routine, c, a => got.push(a))
    r.tick(stateWithMobs(-1, 0))                                   // no mobs → walk to 50
    expect(got.some(a => a.kind === 'press' && a.key === 'right')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/runner.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement runner.ts**

```ts
// src/routine/runner.ts
import type { Action, GameState } from '@/core/types'
import type { Routine } from './schema'
import { compileWhen } from './dsl'
import { MovementFsm } from './movement'
import type { Clock } from '@/core/clock'

export function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(s)
  if (!m) throw new Error(`bad duration: ${s}`)
  const n = Number(m[1])
  return n * (m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : 3_600_000)
}

interface CompiledRule {
  kind: 'when' | 'every'
  predicate?: (s: GameState) => boolean
  everyMs?: number
  cooldownMs: number
  action: Action
}

export class RoutineRunner {
  private rules: CompiledRule[]
  private fsm: MovementFsm
  private lastFiredAt = new Map<number, number>()

  constructor(private routine: Routine, private clock: Clock, private emit: (a: Action) => void) {
    this.rules = routine.rotation.map<CompiledRule>(rule => {
      if ('when' in rule) {
        return { kind: 'when', predicate: compileWhen(rule.when),
          cooldownMs: rule.cooldown_ms ?? 0, action: rule.action }
      }
      return { kind: 'every', everyMs: parseDuration(rule.every),
        cooldownMs: parseDuration(rule.every), action: rule.action }
    })
    this.fsm = new MovementFsm(routine.movement, clock)
  }

  tick(state: GameState): void {
    let attacked = false
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i]
      const last = this.lastFiredAt.get(i) ?? -Infinity
      if (this.clock.now() - last < r.cooldownMs) continue
      const fire = r.kind === 'when'
        ? r.predicate!(state)
        : (this.clock.now() - last) >= r.everyMs!
      if (!fire) continue
      this.lastFiredAt.set(i, this.clock.now())
      this.emit(r.action)
      if (r.kind === 'when') attacked = true
      break    // first match wins
    }
    if (!attacked) {
      const px = state.player.pos?.x ?? 0
      this.fsm.tick({ playerX: px, attacking: attacked }, this.emit)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/runner.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/routine/runner.ts tests/unit/runner.test.ts
git commit -m "feat(routine): RoutineRunner ties rotation + movement"
```

---

## Phase 6 — Orchestrator + Run Modes + Replay

### Task 6.1: Replay artifact writer

**Files:**
- Create: `src/replay/writer.ts`
- Test: `tests/unit/replay.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/unit/replay.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReplayWriter } from '@/replay/writer'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'replay-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('ReplayWriter', () => {
  it('writes JSONL entries', async () => {
    const w = new ReplayWriter(dir)
    await w.write('actions', { t: 0, kind: 'press', key: 'ctrl' })
    await w.write('actions', { t: 100, kind: 'press', key: 'shift' })
    await w.close()
    const text = readFileSync(join(dir, 'actions.jsonl'), 'utf8')
    expect(text.trim().split('\n').length).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/replay.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement writer.ts**

```ts
// src/replay/writer.ts
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

export type ReplayChannel = 'perception' | 'states' | 'actions' | 'events'

export class ReplayWriter {
  private streams = new Map<ReplayChannel, WriteStream>()

  constructor(private dir: string) { mkdirSync(dir, { recursive: true }) }

  private get(channel: ReplayChannel): WriteStream {
    if (!this.streams.has(channel)) {
      this.streams.set(channel, createWriteStream(join(this.dir, `${channel}.jsonl`), { flags: 'a' }))
    }
    return this.streams.get(channel)!
  }

  write(channel: ReplayChannel, entry: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      this.get(channel).write(JSON.stringify(entry) + '\n', err => err ? reject(err) : resolve())
    })
  }

  async close(): Promise<void> {
    await Promise.all([...this.streams.values()].map(s => new Promise<void>(r => s.end(() => r()))))
    this.streams.clear()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/replay.test.ts`
Expected: 1 passing.

- [ ] **Step 5: Commit**

```bash
git add src/replay/writer.ts tests/unit/replay.test.ts
git commit -m "feat(replay): JSONL artifact writer"
```

### Task 6.2: Orchestrator wiring + run modes

**Files:**
- Create: `src/core/orchestrator.ts`
- Test: `tests/integration/orchestrator.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
// tests/integration/orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { Orchestrator } from '@/core/orchestrator'
import { TypedBus } from '@/core/bus'
import { FakeClock } from '@/core/clock'
import type { Routine } from '@/routine/schema'
import type { GameState } from '@/core/types'

const routine: Routine = {
  game: 'maplestory',
  resolution: [1920, 1080],
  window_title: 'MapleStory',
  regions: { hp: {x:0,y:0,w:1,h:1}, mp: {x:0,y:0,w:1,h:1}, minimap: {x:0,y:0,w:1,h:1} },
  reflex: [],
  perception: { model: 'm', fps: 8, classes: ['player'], confidence_threshold: 0.5 },
  rotation: [{ when: 'mobs_in_range(300) >= 1', action: { kind: 'press', key: 'ctrl' }, cooldown_ms: 0 }],
  movement: { primitives: [{ op: 'walk_to_x', x: 50 }], loop: true, pause_while_attacking: true },
}

const stateStream: GameState[] = [
  { timestamp: 0, player: { pos: {x:0,y:0}, hp: 1, mp: 1 },
    enemies: [{ type: 'mob_generic', pos: {x:100,y:0}, distancePx: 100 }],
    flags: { runeActive: false, outOfBounds: false }, popup: null },
]

describe('Orchestrator (dry-run)', () => {
  it('emits actions but does not call backend', async () => {
    const bus = new TypedBus()
    const clock = new FakeClock(0)
    const sendKey = vi.fn(async () => {})
    const o = new Orchestrator({
      routine, bus, clock, mode: 'dry-run',
      backend: { sendKey, sendCombo: vi.fn(async () => {}), sendMove: vi.fn(async () => {}),
                 releaseAll: vi.fn(async () => {}), canRunBackground: () => false },
      perception: { next: async () => null },
      states: stateStream,
      getForegroundTitle: async () => 'MapleStory',
    })
    await o.runOneTick()
    expect(sendKey).not.toHaveBeenCalled()
  })

  it('live mode does call backend', async () => {
    const bus = new TypedBus()
    const clock = new FakeClock(0)
    const sendKey = vi.fn(async () => {})
    const o = new Orchestrator({
      routine, bus, clock, mode: 'live',
      backend: { sendKey, sendCombo: vi.fn(async () => {}), sendMove: vi.fn(async () => {}),
                 releaseAll: vi.fn(async () => {}), canRunBackground: () => false },
      perception: { next: async () => null },
      states: stateStream,
      getForegroundTitle: async () => 'MapleStory',
    })
    await o.runOneTick()
    expect(sendKey).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/integration/orchestrator.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement orchestrator.ts**

```ts
// src/core/orchestrator.ts
import type { GameState, Action } from './types'
import type { TypedBus } from './bus'
import type { Clock } from './clock'
import type { InputBackend } from '@/input/index'
import { ActionScheduler } from './scheduler'
import { Actuator } from './actuator'
import { RoutineRunner } from '@/routine/runner'
import type { Routine } from '@/routine/schema'

export type RunMode = 'dry-run' | 'safe' | 'live'

export interface OrchestratorOpts {
  routine: Routine
  bus: TypedBus
  clock: Clock
  mode: RunMode
  backend: InputBackend
  perception: { next: () => Promise<GameState | null> }
  states?: GameState[]                   // optional override for tests
  getForegroundTitle: () => Promise<string | null>
}

export class Orchestrator {
  private scheduler: ActionScheduler
  private actuator: Actuator
  private routineRunner: RoutineRunner
  private states?: GameState[]
  private stateIdx = 0
  private mode: RunMode

  constructor(private opts: OrchestratorOpts) {
    this.mode = opts.mode
    this.actuator = new Actuator({
      backend: opts.backend, bus: opts.bus, clock: opts.clock,
      getForegroundTitle: opts.getForegroundTitle,
    })
    this.actuator.setTargetWindow(opts.routine.window_title)
    this.scheduler = new ActionScheduler({
      execute: a => this.executeViaActuator(a),
      clock: opts.clock,
    })
    this.routineRunner = new RoutineRunner(opts.routine, opts.clock,
      a => this.scheduler.submit('routine', a, 'routine'))
    this.states = opts.states
  }

  private async executeViaActuator(a: Action): Promise<void> {
    if (this.mode === 'dry-run') {
      this.opts.bus.emit('action.executed', { action: a, backend: 'dry-run', timing: 0 })
      return
    }
    if (this.mode === 'safe' && a.kind !== 'abort' && a.kind !== 'wait') {
      // safe mode: only allow waits + aborts via routine; reflex still flows here too
      // Reflex submits at 'emergency' priority — let those through. Routine actions: drop.
      // We tag through scheduler is not available here; simplest rule: block 'press' under safe mode.
      if (a.kind === 'press' || a.kind === 'combo' || a.kind === 'move') {
        this.opts.bus.emit('action.executed', { action: a, backend: 'safe-blocked', timing: 0 })
        return
      }
    }
    await this.actuator.execute(a)
  }

  async runOneTick(): Promise<void> {
    const state = this.states ? this.states[this.stateIdx++ % this.states.length]
                              : await this.opts.perception.next()
    if (!state) return
    this.opts.bus.emit('state.built', state)
    this.routineRunner.tick(state)
    await this.scheduler.tick()
  }

  pause(reason = 'user') { this.actuator.pause(reason) }
  resume() { this.actuator.resume() }
  abort(reason = 'user') { this.actuator.abort(reason) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/integration/orchestrator.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/core/orchestrator.ts tests/integration/orchestrator.test.ts
git commit -m "feat(core): Orchestrator with dry-run / safe / live modes"
```

---

## Phase 7 — Recorder

### Task 7.1: Recorder module

**Files:**
- Create: `src/recorder/index.ts`
- Create: `src/recorder/frame-writer.ts`
- Test: `tests/unit/recorder.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/unit/recorder.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Recorder } from '@/recorder/index'
import { FakeClock } from '@/core/clock'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rec-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('Recorder', () => {
  it('writes frames + inputs.jsonl + vitals.jsonl + meta.json', async () => {
    const clock = new FakeClock(0)
    const r = new Recorder({
      outDir: root,
      name: 'test',
      clock,
      capture: async () => Buffer.from([0]),     // not real PNG; writer accepts any buffer
      sampleVitals: async () => ({ hp: 0.5, mp: 0.7 }),
      framesPerSec: 5,
    })
    await r.start({ resolution: [1920, 1080], windowTitle: 'MapleStory' })
    r.recordKey({ type: 'keydown', key: 'ctrl', t: 100 })
    await r.stop()
    const dir = join(root, 'test')
    expect(existsSync(join(dir, 'meta.json'))).toBe(true)
    expect(existsSync(join(dir, 'inputs.jsonl'))).toBe(true)
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    expect(meta.windowTitle).toBe('MapleStory')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/recorder.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement frame-writer.ts and index.ts**

```ts
// src/recorder/frame-writer.ts
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export class FrameWriter {
  private idx = 0
  constructor(private dir: string) { mkdirSync(dir, { recursive: true }) }
  write(buf: Buffer): string {
    const name = `${String(this.idx++).padStart(6, '0')}.png`
    writeFileSync(join(this.dir, name), buf)
    return name
  }
}
```

```ts
// src/recorder/index.ts
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { FrameWriter } from './frame-writer'
import type { Clock } from '@/core/clock'

export interface RecorderOpts {
  outDir: string
  name: string
  clock: Clock
  capture: () => Promise<Buffer>
  sampleVitals: () => Promise<{ hp: number; mp: number }>
  framesPerSec: number
}

export interface KeyEvent { type: 'keydown' | 'keyup'; key: string; t: number }
export interface SessionMeta { resolution: [number, number]; windowTitle: string }

export class Recorder {
  private dir: string
  private framesDir: string
  private fw: FrameWriter
  private cancelTimer?: () => void
  private startedAt = 0

  constructor(private opts: RecorderOpts) {
    this.dir = join(opts.outDir, opts.name)
    this.framesDir = join(this.dir, 'frames')
    mkdirSync(this.dir, { recursive: true })
    this.fw = new FrameWriter(this.framesDir)
  }

  async start(meta: SessionMeta): Promise<void> {
    this.startedAt = this.opts.clock.now()
    writeFileSync(join(this.dir, 'meta.json'), JSON.stringify({
      ...meta, startedAt: this.startedAt, version: '0.0.1',
    }, null, 2))
    const periodMs = Math.floor(1000 / this.opts.framesPerSec)
    this.cancelTimer = this.opts.clock.setInterval(() => { this.captureOnce().catch(() => {}) }, periodMs)
  }

  recordKey(ev: KeyEvent): void {
    appendFileSync(join(this.dir, 'inputs.jsonl'), JSON.stringify(ev) + '\n')
  }

  private async captureOnce(): Promise<void> {
    const buf = await this.opts.capture()
    this.fw.write(buf)
    const v = await this.opts.sampleVitals()
    appendFileSync(join(this.dir, 'vitals.jsonl'),
      JSON.stringify({ t: this.opts.clock.now() - this.startedAt, ...v }) + '\n')
  }

  async stop(): Promise<void> { this.cancelTimer?.() }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/recorder.test.ts`
Expected: 1 passing.

- [ ] **Step 5: Commit**

```bash
git add src/recorder tests/unit/recorder.test.ts
git commit -m "feat(recorder): capture frames + inputs + vitals + meta"
```

---

## Phase 8 — Analyzer (Anthropic SDK)

### Task 8.1: Prompt template + post-process validator

**Files:**
- Create: `src/analyzer/prompt.ts`
- Create: `src/analyzer/post-process.ts`
- Test: `tests/unit/post-process.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/unit/post-process.test.ts
import { describe, it, expect } from 'vitest'
import { extractAndValidate } from '@/analyzer/post-process'

describe('extractAndValidate', () => {
  it('extracts JSON from fenced block and validates', () => {
    const llm = '```json\n{"game":"maplestory","resolution":[1920,1080],"window_title":"MapleStory","regions":{"hp":{"x":0,"y":0,"w":1,"h":1},"mp":{"x":0,"y":0,"w":1,"h":1},"minimap":{"x":0,"y":0,"w":1,"h":1}},"reflex":[],"perception":{"model":"m","fps":8,"classes":["player"],"confidence_threshold":0.6},"rotation":[],"movement":{"primitives":[],"loop":true,"pause_while_attacking":true}}\n```'
    const r = extractAndValidate(llm)
    expect(r.ok).toBe(true)
  })
  it('returns error on bad JSON', () => {
    const r = extractAndValidate('not json')
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/post-process.test.ts`
Expected: fail — module not found.

- [ ] **Step 3: Implement post-process.ts and prompt.ts**

```ts
// src/analyzer/post-process.ts
import { Routine } from '@/routine/schema'

const FENCE = /```(?:json)?\s*([\s\S]*?)```/

export type ExtractResult =
  | { ok: true;  routine: Routine }
  | { ok: false; error: string }

export function extractAndValidate(text: string): ExtractResult {
  let body = text.trim()
  const m = FENCE.exec(body)
  if (m) body = m[1].trim()
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch (e) {
    return { ok: false, error: `JSON parse error: ${(e as Error).message}` }
  }
  const r = Routine.safeParse(parsed)
  if (!r.success) return { ok: false, error: r.error.message }
  return { ok: true, routine: r.data }
}
```

```ts
// src/analyzer/prompt.ts
export const SYSTEM_PROMPT = `You are an expert reverse-engineer of Maplestory farming demonstrations. You receive sampled gameplay frames + a keystroke log + a vitals timeline. You output a STRICT JSON document matching the routine schema, wrapped in a single \`\`\`json fenced block. Do not include any prose outside the fence.`

export function buildUserPrompt(opts: {
  framesSampled: number
  resolution: [number, number]
  windowTitle: string
  inputsJsonl: string
  vitalsJsonl: string
}): string {
  return `Analyze this Maplestory farming session.

- Resolution: ${opts.resolution.join('x')}
- Window title: ${opts.windowTitle}
- Frames sampled: ${opts.framesSampled}

INPUTS LOG (truncated):
${opts.inputsJsonl.slice(0, 4000)}

VITALS LOG (truncated):
${opts.vitalsJsonl.slice(0, 4000)}

Output a complete routine JSON. Required keys:
- game ("maplestory"), resolution, window_title
- regions { hp, mp, minimap }
- reflex (HP/MP potion rules)
- perception { model: "yolov8n-maplestory", fps, classes, confidence_threshold }
- rotation (perception-gated when rules + every-cadence buffs)
- movement { primitives, loop, pause_while_attacking }
- bounds { x: [min, max], y: [min, max] } — derived from MINIMAP-coordinate extents observed across the recording. The minimap is the small rectangle in the top-right; the player appears as a bright colored dot. Bounds are in minimap-local coords, NOT screen coords.
- minimap_player_color { rgb: [r, g, b], tolerance } — the dot color you observed in the minimap region of the sampled frames.
- movement.primitives — compile from the player's MINIMAP trajectory: \`walk_to_x\` uses minimap x; \`jump_left\`/\`jump_right\`/\`drop_down\` map to vertical platform transitions in minimap y.
- stop_condition (include \`out_of_bounds: { margin: 10 }\` so the bot aborts on knockback)

Use \`when: 'mobs_in_range(<px>) >= <N>'\` style for attacks.
Mark "unreviewed": true at the top level.`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/post-process.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/analyzer/prompt.ts src/analyzer/post-process.ts tests/unit/post-process.test.ts
git commit -m "feat(analyzer): prompt template + JSON extract/validate with retry support"
```

### Task 8.2: Analyzer with Anthropic SDK + retry

**Files:**
- Create: `src/analyzer/index.ts`

- [ ] **Step 1: Implement index.ts**

```ts
// src/analyzer/index.ts
import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt'
import { extractAndValidate } from './post-process'
import type { Routine } from '@/routine/schema'

export interface AnalyzeOpts {
  recordingDir: string
  outRoutinePath: string
  apiKey: string
  model?: string
  framesEvery?: number
  maxRetries?: number
}

export async function analyze(opts: AnalyzeOpts): Promise<Routine> {
  const meta = JSON.parse(readFileSync(join(opts.recordingDir, 'meta.json'), 'utf8'))
  const inputs = readFileSync(join(opts.recordingDir, 'inputs.jsonl'), 'utf8')
  const vitals = readFileSync(join(opts.recordingDir, 'vitals.jsonl'), 'utf8')
  const frameNames = readdirSync(join(opts.recordingDir, 'frames')).sort()
  const every = opts.framesEvery ?? Math.max(1, Math.floor(frameNames.length / 40))
  const sampled = frameNames.filter((_, i) => i % every === 0)

  const images = sampled.slice(0, 20).map(name => {
    const data = readFileSync(join(opts.recordingDir, 'frames', name))
    return {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png' as const, data: data.toString('base64') },
    }
  })

  const client = new Anthropic({ apiKey: opts.apiKey })
  const userText = buildUserPrompt({
    framesSampled: sampled.length, resolution: meta.resolution,
    windowTitle: meta.windowTitle, inputsJsonl: inputs, vitalsJsonl: vitals,
  })

  let lastError = ''
  for (let attempt = 0; attempt <= (opts.maxRetries ?? 2); attempt++) {
    const messageContent = [
      ...images,
      { type: 'text' as const, text: attempt === 0 ? userText
          : `${userText}\n\nPREVIOUS ATTEMPT FAILED VALIDATION:\n${lastError}\nFix the JSON to match the schema exactly.` },
    ]
    const resp = await client.messages.create({
      model: opts.model ?? 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: messageContent }],
    })
    const text = resp.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n')
    const r = extractAndValidate(text)
    if (r.ok) {
      const obj = { unreviewed: true, ...r.routine, recorded_from: opts.recordingDir }
      writeFileSync(opts.outRoutinePath, YAML.stringify(obj))
      return r.routine
    }
    lastError = r.error
  }
  throw new Error(`analyze: validation failed after retries: ${lastError}`)
}
```

- [ ] **Step 2: No automated test (network/cost). Manual smoke run after CLI ready.**

- [ ] **Step 3: Commit**

```bash
git add src/analyzer/index.ts
git commit -m "feat(analyzer): Anthropic SDK call with validate-and-retry"
```

---

## Phase 9 — CLI + doctor + Hotkey wiring

### Task 9.1: CLI entrypoint with all commands

**Files:**
- Create: `src/cli.ts`
- Create: `src/doctor.ts`

- [ ] **Step 1: Implement doctor.ts**

```ts
// src/doctor.ts
import { existsSync } from 'node:fs'
import chalk from 'chalk'
import { ScreenshotDesktopCapture } from '@/capture/screenshot-desktop'
import { ForegroundNutBackend } from '@/input/foreground-nut'
import { getForegroundWindowTitle } from '@/core/focus'

export async function runDoctor(): Promise<number> {
  let ok = true
  const pass = (m: string) => console.log(chalk.green('✓'), m)
  const fail = (m: string) => { console.log(chalk.red('✗'), m); ok = false }
  const warn = (m: string) => console.log(chalk.yellow('!'), m)

  const major = Number(process.versions.node.split('.')[0])
  major >= 20 ? pass(`Node ${process.versions.node}`) : fail(`Node 20+ required, found ${process.versions.node}`)

  pass(`Platform: ${process.platform}-${process.arch}`)

  try {
    const t0 = Date.now()
    await new ScreenshotDesktopCapture().captureScreen()
    pass(`Capture latency: ${Date.now() - t0} ms`)
  } catch (e) {
    fail(`Capture failed: ${(e as Error).message}`)
  }

  try {
    new ForegroundNutBackend()
    pass('nut.js loaded')
  } catch (e) {
    fail(`nut.js failed: ${(e as Error).message}`)
  }

  process.env.ANTHROPIC_API_KEY ? pass('ANTHROPIC_API_KEY set') : warn('ANTHROPIC_API_KEY not set (needed for analyze)')

  if (!existsSync('models/yolov8n-maplestory.onnx')) warn('models/yolov8n-maplestory.onnx missing — fetch via release')
  else pass('YOLO model present')

  const fg = await getForegroundWindowTitle()
  if (fg && fg.toLowerCase().includes('maplestory')) pass(`Maplestory focused: ${fg}`)
  else warn('Maplestory window not currently focused (optional)')

  return ok ? 0 : 1
}
```

- [ ] **Step 2: Implement cli.ts**

```ts
// src/cli.ts
import { Command } from 'commander'
import { readFileSync, existsSync } from 'node:fs'
import YAML from 'yaml'
import 'dotenv/config'
import { Routine } from '@/routine/schema'
import { Orchestrator, type RunMode } from '@/core/orchestrator'
import { TypedBus } from '@/core/bus'
import { RealClock } from '@/core/clock'
import { ScreenshotDesktopCapture } from '@/capture/screenshot-desktop'
import { ForegroundNutBackend } from '@/input/foreground-nut'
import { getForegroundWindowTitle } from '@/core/focus'
import { HotkeyService } from '@/core/hotkeys'
import { Recorder } from '@/recorder/index'
import { analyze } from '@/analyzer/index'
import { runDoctor } from '@/doctor'
import { logger } from '@/core/logger'

const program = new Command()
program.name('maplestory.ai').description('Maplestory farming co-pilot').version('0.0.1')

program.command('doctor').description('Validate environment').action(async () => {
  process.exit(await runDoctor())
})

program.command('record')
  .requiredOption('--name <n>', 'recording name')
  .option('--out <dir>', 'output dir', 'recordings')
  .option('--fps <n>', 'frames per sec', '5')
  .action(async (opts) => {
    const cap = new ScreenshotDesktopCapture()
    const clock = new RealClock()
    const fg = await getForegroundWindowTitle()
    const recorder = new Recorder({
      outDir: opts.out, name: opts.name, clock,
      capture: () => cap.captureScreen(),
      sampleVitals: async () => ({ hp: 1, mp: 1 }),     // v1 stub; reflex sampler available via capture
      framesPerSec: Number(opts.fps),
    })
    await recorder.start({ resolution: [1920, 1080], windowTitle: fg ?? 'MapleStory' })
    logger.info('recording... press F12 to stop')
    await new Promise<void>(resolve => {
      const hk = new HotkeyService({
        onPauseToggle: () => {},
        onAbort: async () => { await recorder.stop(); hk.stop(); resolve() },
      })
      hk.start()
    })
    logger.info('recording saved')
  })

program.command('analyze <recordingDir>')
  .requiredOption('--out <path>', 'output routine YAML path')
  .action(async (recordingDir, opts) => {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) { logger.error('ANTHROPIC_API_KEY not set'); process.exit(1) }
    await analyze({ recordingDir, outRoutinePath: opts.out, apiKey: key })
    logger.info(`wrote ${opts.out}`)
  })

program.command('run <routinePath>')
  .option('--mode <mode>', 'dry-run|safe|live', 'dry-run')
  .action(async (routinePath, opts) => {
    if (!existsSync(routinePath)) { logger.error('routine not found'); process.exit(1) }
    const obj = YAML.parse(readFileSync(routinePath, 'utf8'))
    if (obj.unreviewed) { logger.error('routine marked unreviewed: true — review and remove flag first'); process.exit(1) }
    const routine = Routine.parse(obj)
    const bus = new TypedBus()
    const clock = new RealClock()
    const backend = new ForegroundNutBackend()
    const o = new Orchestrator({
      routine, bus, clock, mode: opts.mode as RunMode,
      backend, perception: { next: async () => null },     // wired in Phase 4 integration
      getForegroundTitle: getForegroundWindowTitle,
    })
    let stop = false
    const hk = new HotkeyService({
      onPauseToggle: () => o.pause('hotkey'),
      onAbort:       () => { o.abort('hotkey'); stop = true },
    })
    hk.start()
    logger.info(`running in ${opts.mode}. F10 pause, F12 abort`)
    while (!stop) { await o.runOneTick(); await new Promise(r => setTimeout(r, 100)) }
    hk.stop()
  })

program.parseAsync(process.argv)
```

- [ ] **Step 3: Add dotenv dependency**

Run: `pnpm add dotenv`

- [ ] **Step 4: Smoke test build**

Run: `pnpm build`
Expected: clean compile (no errors).

Run: `pnpm tsx src/cli.ts doctor`
Expected: prints checklist.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/doctor.ts package.json pnpm-lock.yaml
git commit -m "feat(cli): commander entrypoint + doctor command"
```

### Task 9.2: Wire YOLO + Reflex into Orchestrator's perception loop

**Files:**
- Modify: `src/cli.ts` (run command)
- Modify: `src/core/orchestrator.ts` (accept reflex worker)

- [ ] **Step 1: Add reflex worker + perception wiring + minimap to Orchestrator**

In `src/core/orchestrator.ts`, extend the constructor to accept optional `yolo`, `capture`, `reflex`, `minimap`, and `bounds`. Update `runOneTick` to drive Reflex first, then fetch a screenshot, then call YOLO + MinimapSampler in parallel, then `buildGameState(frame, vitals, minimapPos, bounds)`.

```ts
// add imports at top of orchestrator.ts
import { buildGameState, type Bounds } from '@/perception/state-builder'
import type { ReflexWorker } from '@/reflex/pixel-sampler'
import type { YoloPerception } from '@/perception/yolo'
import type { CaptureProvider } from '@/capture/index'
import type { MinimapSampler } from '@/perception/minimap'

// extend OrchestratorOpts
export interface OrchestratorOpts {
  // ...existing fields...
  yolo?: YoloPerception
  capture?: CaptureProvider
  reflex?: ReflexWorker
  minimap?: MinimapSampler
  bounds?: Bounds
  boundsMargin?: number
}

// inside Orchestrator class, replace runOneTick:
async runOneTick(): Promise<void> {
  if (this.opts.reflex) await this.opts.reflex.tick()
  let state: GameState | null = null
  if (this.states) state = this.states[this.stateIdx++ % this.states.length]
  else if (this.opts.yolo && this.opts.capture) {
    const buf = await this.opts.capture.captureScreen()
    const sharp = (await import('sharp')).default
    const meta = await sharp(buf).metadata()
    const [frame, minimapPos] = await Promise.all([
      this.opts.yolo.run(buf, meta.width ?? 1920, meta.height ?? 1080),
      this.opts.minimap ? this.opts.minimap.sample() : Promise.resolve(null),
    ])
    const vitals = this.opts.reflex?.current() ?? { hp: 1, mp: 1 }
    state = buildGameState(frame, vitals, minimapPos, this.opts.bounds ?? null, this.opts.boundsMargin ?? 10)
    if (state.flags.outOfBounds) {
      this.abort('out_of_bounds')
      return
    }
  } else if (this.opts.perception) {
    state = await this.opts.perception.next()
  }
  if (!state) return
  this.opts.bus.emit('state.built', state)
  this.routineRunner.tick(state)
  await this.scheduler.tick()
}
```

- [ ] **Step 2: Update `run` command in cli.ts to construct YOLO + Reflex + Minimap from routine**

```ts
// inside the `run` action, after parsing routine and before `new Orchestrator`:
import { YoloPerception } from '@/perception/yolo'
import { ReflexWorker } from '@/reflex/pixel-sampler'
import { MinimapSampler } from '@/perception/minimap'
import sharp from 'sharp'

const cap = new ScreenshotDesktopCapture()
const yolo = new YoloPerception({
  modelPath: `models/${routine.perception.model}.onnx`,
  classes: routine.perception.classes,
  confidenceThreshold: routine.perception.confidence_threshold,
})
await yolo.load()

const reflex = new ReflexWorker({
  clock,
  submit: a => o.scheduleEmergency(a),
  checks: routine.reflex.map(r => ({
    region: r.region, metric: r.metric, below: r.below, cooldownMs: r.cooldown_ms,
    action: r.action,
  })),
  sample: async (regionName) => {
    const r = routine.regions[regionName as keyof typeof routine.regions]
    if (!r) return Buffer.alloc(0)
    return cap.captureRegion(r as any)
  },
})

const minimapColor = routine.minimap_player_color ?? { rgb: [240, 220, 60] as [number, number, number], tolerance: 30 }
const minimap = new MinimapSampler({
  captureRegion: (r) => cap.captureRegion(r),
  region: routine.regions.minimap,
  matcher: minimapColor,
})

const bounds = routine.bounds
  ? { x: routine.bounds.x as [number, number], y: routine.bounds.y as [number, number] }
  : undefined

// pass yolo + cap + reflex + minimap + bounds into Orchestrator
```

Add the public `scheduleEmergency` to Orchestrator:

```ts
// add to Orchestrator
scheduleEmergency(a: Action) { this.scheduler.submit('reflex', a, 'emergency') }
```

- [ ] **Step 3: Verify build**

Run: `pnpm build && pnpm test`
Expected: clean. (Existing tests still pass.)

- [ ] **Step 4: Commit**

```bash
git add src/core/orchestrator.ts src/cli.ts
git commit -m "feat(core): Orchestrator wires capture + YOLO + Reflex into live loop"
```

---

## Phase 10 — README + Polish

### Task 10.1: README quickstart

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README.md**

```markdown
# maplestory.ai

Record yourself farming a Maplestory map, let an LLM analyze it, and replay the routine on demand.

## Quickstart

\`\`\`bash
pnpm install
cp .env.example .env
# edit .env → ANTHROPIC_API_KEY=sk-ant-...
pnpm build
pnpm dev doctor
\`\`\`

### Record + analyze + run

\`\`\`bash
pnpm dev record --name arcana
# play 2-3 cycles, F12 to stop
pnpm dev analyze recordings/arcana --out routines/arcana.yaml
# review routines/arcana.yaml — remove "unreviewed: true"
pnpm dev run routines/arcana.yaml --mode dry-run
pnpm dev run routines/arcana.yaml --mode safe
pnpm dev run routines/arcana.yaml --mode live
\`\`\`

## Hotkeys
- F10 — pause / resume
- F12 — abort

## Permissions
- macOS: grant Accessibility + Screen Recording to your terminal.
- Windows: standard user; whitelist node binary in antivirus.

## Disclaimer
Use at your own risk. Maplestory ToS prohibits automation.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README quickstart"
```

### Task 10.2: Final integration smoke test

- [ ] **Step 1: Run full suite**

Run: `pnpm lint && pnpm test && pnpm build`
Expected: clean.

- [ ] **Step 2: Manual smoke**

```bash
pnpm dev doctor
```
Expected: all checks pass except optional warnings.

- [ ] **Step 3: Commit any final fixes**

```bash
git add .
git commit -m "chore: final lint + test pass"
```

---

## Self-Review Notes

**Spec coverage check:**
- §2 Architecture → Phases 1–6 cover all 5 runtime modules + scheduler.
- §3 Tech stack → Task 0.1 pins all deps.
- §4 Environment requirements → Task 9.1 doctor validates.
- §5 Type contracts → Task 1.1 implements all schemas.
- §6 Project structure → Task 0.1 + later tasks create all directories.
- §7 Recording → Phase 7.
- §8 Analyzer → Phase 8.
- §9 Perception → Phase 4.
- §10 Reflex → Phase 3.
- §11 Scheduler/Actuator → Phase 2 + 3.
- §12 Movement primitives → Task 5.3.
- §13 Run modes → Task 6.2.
- §14 Testing — Clock + replay covered in Tasks 1.2 + 6.1.
- §15 MVP scope — all "in" items have a phase.
- §16 Phases — plan phases align with spec phases.

**Deferred (matches spec non-goals):**
- Rune solver, brain layer, web dashboard, background InputBackend — explicitly out of v1.
- OCR popup handling (PerceptionFrame.ocr field present; runtime usage deferred to v1.2).

**Type consistency:** `Action` discriminated union, `GameState`, `PerceptionFrame`, `Routine` schema names, and `ActionPriority` literals are referenced consistently across tasks.
