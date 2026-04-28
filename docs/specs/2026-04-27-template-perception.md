# ADR — Template Perception (v1.1)

**Date:** 2026-04-27
**Status:** Accepted
**Supersedes:** v1 spec §9 Perception (YOLO-only)
**Owner:** aronleedev@gmail.com

## Context

v1 spec required users to label ~500 Maplestory frames + train YOLOv8 in Colab + export ONNX before the bot could perceive mobs. This is:

- A 1–2 hour gate before first run, including signing up for Roboflow.
- Stale the moment Nexon ships new mob species or a player upgrades to a new region.
- Ironic for an "AI-native" project — the user does the AI work, the tool just runs inference.

A user who plays Maplestory routinely changes regions (Henesys → El Nath → Arcana → Grandis) within weeks. Forcing per-region YOLO retrains is impractical.

## Decision

Replace YOLO as the **default** perception path with **auto-calibration via Claude Code + template matching**:

1. User runs `calibrate <map>` once when first farming a new map (~30 sec).
2. Tool captures 10 frames over 10 sec, writes `CALIBRATE.md` prompt bundle.
3. User invokes Claude Code slash command `/calibrate-map`. Claude Code reads the frames and emits a `manifest-source.json` listing each visible mob species + a bbox in one frame to crop as a template.
4. `crop-templates <map>` slices the bboxes into PNGs in `data/templates/<map>/`.
5. Runtime uses pure-TS normalized cross-correlation (NCC) against those templates.

YOLO is retained as `mode: yolo` for power users who need maximum precision and have done the labeling work.

## Architecture

```
Capture → TemplateLibrary.detectAll() → PerceptionFrame → StateBuilder → GameState
                ↑
            data/templates/<map>/<class>-<variant>.png   (calibrate)
```

Existing modules (Reflex, ActionScheduler, Orchestrator, Routine, Recorder, Analyzer, Minimap) are untouched. Only Perception is swapped.

### Routine YAML (discriminated union on `mode`)

```yaml
perception:
  mode: template          # default
  template_dir: data/templates/arcana
  fps: 12
  match_threshold: 0.75
  search_region: { x: 0, y: 200, w: 1920, h: 600 }
```

vs.

```yaml
perception:
  mode: yolo              # opt-in
  model: yolov8n-maplestory
  fps: 8
  classes: [player, mob_generic, rune, portal]
  confidence_threshold: 0.6
```

## Performance Targets

| Stage | Target |
|---|---|
| Capture (Mac) | 30–80ms (unchanged from v1) |
| Resize / crop to search_region | 5–10ms |
| NCC for 5 templates × cropped region (~600×400) | 30–50ms (pure TS, single thread) |
| NMS + state build | <5ms |
| **Total per tick** | **<100ms (10 fps)** |

Pure TS NCC: ~600×400 search × 60×80 template = 540 × 320 × 60 × 80 = ~830M multiply-adds. With stride 2 + early-exit + integral images: ~10–30ms in Node. Acceptable.

## Trade-offs

| | YOLO (v1) | Template (v1.1) |
|---|---|---|
| First-run gate | 1–2 hr (label + train) | 30 sec (calibrate) |
| Per-region adaptation | Retrain or rely on generalization | Recalibrate (30 sec) |
| Robustness to lighting | High | Medium (mitigation: lower threshold) |
| Robustness to scale variance | High | Low (single scale v1.1; multi-scale v1.2) |
| Animation states | Free | Capture multiple variants per mob |
| Dependency footprint | onnxruntime + 6 MB model | None new |
| Cross-platform | onnxruntime native | Pure TS + sharp |

## Fallback Rules

- If `match_threshold` not met for any template across N seconds while user takes damage (HP drop detected via Reflex), bot logs `perception_blind` and aborts. User reruns `calibrate`.
- `--perception=yolo` flag overrides routine YAML mode at runtime — escape hatch for problem maps.

## Non-Goals (deferred)

- Multi-scale template matching (v1.2).
- Auto-recalibration on detection drop (v1.2).
- OpenCV native dependency (v1.3 if pure-TS NCC proves too slow at full screen).
- Removing YOLO code path (kept indefinitely as `mode: yolo`).

## Risks

| Risk | Mitigation |
|---|---|
| NCC too slow at full-screen 1920×1080 | Default `search_region` crops to 600×400 near-player zone; analyzer infers it from recording. Stride 2. Luminance-only (1 channel). |
| Templates miss animation frames not in calibration | Calibrate captures 10 sec → varied states; Claude returns 1–3 variants per mob. |
| Maplestory client patch shifts mob colors / sprites | Recalibrate. Same cost as a YOLO retrain failure but ~1000× faster recovery. |
| Backward compatibility with v1 routines | Schema discriminator + default to `mode: 'yolo'` when missing keeps old YAMLs valid. |

## Acceptance

- `calibrate <name>` produces `data/templates/<name>/manifest.json` after one Claude Code invocation.
- `run <routine>` with `mode: template` farms a map without YOLO loaded.
- Per-tick perception latency <80ms on Mac CPU at 1920×1080 with cropped search region.
- All existing v1 tests pass.
- ≥6 new tests covering NCC, library, schema, orchestrator branch.
