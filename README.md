# maplestory.ai

Maplestory farming co-pilot. v2 architecture: minimap-based navigation +
YOLOv8 detection for player/mob recognition.

> **Branch status**: `main` holds the v1.4.1 ZNCC-based pipeline (tagged
> `v1.4.1-final`). Active development is on `v2-yolo` where ZNCC was
> replaced with a YOLOv8 ONNX detector. The v2 README sections below are
> the source of truth — older sections describing the recording/analyze
> flow are stale and will be rewritten once v2 ships end-to-end.

## v2 workflow (Henesys, one-map-at-a-time)

```bash
# 1. One-time calibration (regions, minimap, bounds, waypoints):
npm run dev -- calibrate henesys

# 2. Capture training frames while playing normally:
npm run dev -- capture henesys --duration 10m --fps 2 --routine routines/henesys.yaml

# 3. Label ~30-50 frames manually to bootstrap (~15 min):
npm run dev -- label henesys

# 4. Quick-train a weak model so the labeler can pre-fill suggestions:
python3 -m venv .venv && source .venv/bin/activate
pip install -r python/requirements.txt
python python/train.py henesys --quick   # 20 epochs, ~10 min on M4
python python/export_onnx.py henesys

# 5. Reopen the labeler — `p` key (or "predict" button) now pre-fills
#    boxes from the bootstrap model. Accept/edit instead of drawing.
#    The remaining 150-350 frames take ~10-15 min instead of an hour.
npm run dev -- label henesys

# 6. Final training pass with the full dataset:
python python/train.py henesys           # 80 epochs
python python/export_onnx.py henesys

# 7. Run the bot:
npm run dev -- run routines/henesys.yaml --mode dry-run
npm run dev -- run routines/henesys.yaml --mode safe
npm run dev -- run routines/henesys.yaml --mode live
```

See `python/README.md` for training details and hard-negative tips.

## Stack

TypeScript + Node 18+ / npm. onnxruntime-node for inference, sharp for
image, nut.js for input, screenshot-desktop for capture, fastify for the
calibrator + labeler servers. Python (Ultralytics + ONNX) is used at
training time only — never at runtime.

## Quickstart

```bash
git clone https://github.com/AronLEEdev/maplestory-ai
cd maplestory-ai
npm install
npm run build
npm run dev -- doctor
```

`doctor` prints green/red checklist. Most warnings (missing model, MS not focused) are fine on first run.

### Record + analyze + run

```bash
# 1. Open Maplestory, walk to the map you want to farm.
npm run dev -- record --name arcana
# play 2-3 cycles manually, F12 stops

# 2. Generate analysis prompt bundle. No API key, no network.
npm run dev -- analyze recordings/arcana --out routines/arcana.yaml

# 3. Open Claude Code in this repo and run the slash command:
#    /analyze-recording recordings/arcana/ANALYZE.md
# Claude Code reads frames + logs and writes routines/arcana.yaml.
#
# (Optional: if you have an ANTHROPIC_API_KEY and prefer one-shot SDK:
#  npm run dev -- analyze recordings/arcana --out routines/arcana.yaml --api )

# 4. Open routines/arcana.yaml, sanity-check, remove `unreviewed: true`.

# 4. Dry-run (logs only, no input sent).
npm run dev -- run routines/arcana.yaml --mode dry-run

# 5. Safe (Reflex pots only — verify HP/MP detection).
npm run dev -- run routines/arcana.yaml --mode safe

# 6. Live.
npm run dev -- run routines/arcana.yaml --mode live
```

## Hotkeys

- **F10** pause / resume
- **F12** abort (releases all keys, exits clean)

## Permissions

- **macOS**: System Settings → Privacy & Security → grant **Accessibility** + **Screen Recording** to Terminal (or your IDE).
- **Windows**: standard user. Whitelist `node.exe` in antivirus if flagged.

## Environment notes

- **Node 18+** required. Node 20 LTS or 22 recommended. `.nvmrc` pins 20 as the default; `nvm use` will pick it up.
- `npm install` compiles native deps (sharp, onnxruntime-node, nut.js). First run takes ~1-2 min.

## Disclaimer

Use at your own risk. Maplestory ToS prohibits automation. This project is for research and personal use.
