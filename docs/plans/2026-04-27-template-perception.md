# v1.1 Template Perception — Implementation Plan

> Spec: [docs/specs/2026-04-27-template-perception.md](../specs/2026-04-27-template-perception.md)
> v1 plan: [docs/plans/2026-04-24-maplestory-ai-v1-implementation.md](2026-04-24-maplestory-ai-v1-implementation.md)

**Goal:** Replace YOLO as default perception with Claude Code-driven calibration + template matching. Retain YOLO behind `mode: yolo`.

**Estimated effort:** ~13 hrs / 2 working days.

---

## Phase 0 — Spec + plan docs (this file)

- [x] `docs/specs/2026-04-27-template-perception.md`
- [x] `docs/plans/2026-04-27-template-perception.md`

## Phase 1 — NCC core

**Files:**
- Create: `src/perception/template-match.ts`
- Test: `tests/unit/template-match.test.ts`

**API:**
```ts
export interface TemplateMatch {
  bbox: [number, number, number, number]
  score: number
  class: string
}
export function findMatches(
  haystackRgb: Buffer, hw: number, hh: number,
  templateRgb: Buffer, tw: number, th: number,
  templateClass: string, threshold: number,
  stride?: number,
): TemplateMatch[]
```

Algorithm: normalized cross-correlation (NCC) on luminance channel. Stride 2 default. Early-exit when score > 0.95. Return all positions with score ≥ threshold (caller does NMS).

## Phase 2 — Template library

**Files:**
- Create: `src/perception/template-library.ts`
- Test: `tests/unit/template-library.test.ts`
- Test fixtures: `tests/snapshot/fixtures/templates/{manifest.json, *.png}`

**Manifest schema (zod):**
```ts
const Manifest = z.object({
  templates: z.array(z.object({
    file: z.string(),
    class: z.string(),
    source_frame: z.string(),
    bbox_in_source: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    variant: z.string().optional(),
  })),
})
```

**Loader + runner:**
```ts
export class TemplateLibrary {
  static async load(dir: string): Promise<TemplateLibrary>
  detectAll(haystackRgb: Buffer, hw: number, hh: number, threshold: number): TemplateMatch[]
  // applies per-class NMS internally
}
```

## Phase 3 — Auto-calibrate

**Files:**
- Create: `src/perception/auto-calibrate.ts`
- Create: `.claude/commands/calibrate-map.md`
- Modify: `src/cli.ts` — add `calibrate` + `crop-templates` commands

**`calibrate <name>` behavior:**
1. Captures 10 frames at 1 fps over 10 sec via `ScreenshotDesktopCapture`.
2. Saves to `data/calibrations/<name>/frames/0001.png` … `0010.png`.
3. Writes `data/calibrations/<name>/CALIBRATE.md` (instructions + frame paths).
4. Prints next-step block telling user to open Claude Code + run `/calibrate-map`.

**Claude Code's job (per slash command):**
1. Read 10 frames.
2. Identify distinct mob species + 1–3 variant bboxes per species.
3. Write `data/calibrations/<name>/manifest-source.json`.

**`crop-templates <name>` behavior:**
1. Reads `manifest-source.json`.
2. Crops each `bbox_in_source` from the named source frame using `sharp.extract`.
3. Writes PNG to `data/templates/<name>/<class>-<variant>.png`.
4. Writes canonical `data/templates/<name>/manifest.json` referencing the crops.

## Phase 4 — State builder integration

**Files:**
- Modify: `src/core/orchestrator.ts` — branch on `routine.perception.mode`
- Modify: `src/cli.ts` — instantiate `TemplateLibrary` instead of `YoloPerception` when mode=template
- Test: `tests/integration/orchestrator-template.test.ts`

State builder is unchanged; both paths emit the same `PerceptionFrame`.

## Phase 5 — Routine schema discriminated union

**Files:**
- Modify: `src/routine/schema.ts`
- Modify: `tests/unit/routine-schema.test.ts`

```ts
const PerceptionTemplate = z.object({
  mode: z.literal('template'),
  template_dir: z.string(),
  fps: z.number().min(1).max(30),
  match_threshold: z.number().min(0).max(1).default(0.75),
  search_region: Rect.optional(),
})
const PerceptionYolo = z.object({
  mode: z.literal('yolo'),
  model: z.string(),
  fps: z.number().min(1).max(30),
  classes: z.array(z.string()).min(1),
  confidence_threshold: z.number().min(0).max(1),
})
const PerceptionConfig = z.discriminatedUnion('mode', [PerceptionTemplate, PerceptionYolo])
```

Backward-compat: pre-process routine YAML on load — if `perception.mode` missing, inject `mode: 'yolo'`.

## Phase 6 — CLI + doctor

**Files:**
- Modify: `src/cli.ts` — `run` action branches on mode
- Modify: `src/doctor.ts` — drop unconditional YOLO check; warn-level template_dir check

## Phase 7 — Analyzer prompt

**Files:**
- Modify: `src/analyzer/prompt.ts`
- Modify: `src/analyzer/prompt-bundle.ts`

Default LLM output to `mode: template`. Reference user's `data/templates/<map>` dir if present. Note: "calibrate is a separate one-time step; do not generate templates here."

## Phase 8 — README + quickstart

**Files:**
- Modify: `README.md`

New flow:
```
calibrate <map> → /calibrate-map → crop-templates → record → analyze → run
```

YOLO documented under `## Advanced: YOLO perception (opt-in)`.

## Phase 9 — Final smoke

- [ ] `npm test` all green
- [ ] `npx tsc --noEmit` clean
- [ ] `npm run lint` clean
- [ ] Commit per phase, push to origin/main

---

## Acceptance Criteria

- [ ] `calibrate <name>` produces a usable `manifest.json` after Claude Code run.
- [ ] `run <routine>` with `mode: template` farms a map without YOLO loaded.
- [ ] Per-tick perception latency <80ms on Mac CPU with cropped search region.
- [ ] All existing v1 tests pass.
- [ ] ≥6 new tests covering NCC, library load/run, schema discriminator, orchestrator mode branch.
