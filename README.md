# maplestory.ai

Record yourself farming a Maplestory map, let an LLM analyze it, replay the routine on demand.

## Stack

TypeScript + Node 20 LTS / pnpm. YOLOv8 ONNX for object detection, sharp for image, nut.js for input, screenshot-desktop for capture, Anthropic SDK for offline routine analysis.

## Quickstart

```bash
git clone https://github.com/AronLEEdev/maplestory-ai
cd maplestory-ai
pnpm install
cp .env.example .env
# edit .env → ANTHROPIC_API_KEY=sk-ant-...
pnpm build
pnpm dev doctor
```

`doctor` prints green/red checklist. Most warnings (missing model, MS not focused) are fine on first run.

### Record + analyze + run

```bash
# 1. Open Maplestory, walk to the map you want to farm.
pnpm dev record --name arcana
# play 2-3 cycles manually, F12 stops

# 2. Send to Claude. Costs ~$0.05-0.15.
pnpm dev analyze recordings/arcana --out routines/arcana.yaml

# 3. Open routines/arcana.yaml, sanity-check, remove `unreviewed: true`.

# 4. Dry-run (logs only, no input sent).
pnpm dev run routines/arcana.yaml --mode dry-run

# 5. Safe (Reflex pots only — verify HP/MP detection).
pnpm dev run routines/arcana.yaml --mode safe

# 6. Live.
pnpm dev run routines/arcana.yaml --mode live
```

## Hotkeys

- **F10** pause / resume
- **F12** abort (releases all keys, exits clean)

## Permissions

- **macOS**: System Settings → Privacy & Security → grant **Accessibility** + **Screen Recording** to Terminal (or your IDE).
- **Windows**: standard user. Whitelist `node.exe` in antivirus if flagged.

## Environment notes

- Pinned to **Node 20** via `.nvmrc`. Node 24 has a pnpm-install bug; use Node 20 or 22 (`nvm use 20`).
- `pnpm install` compiles native deps (sharp, onnxruntime-node, nut.js). First run takes ~1-2 min.

## Disclaimer

Use at your own risk. Maplestory ToS prohibits automation. This project is for research and personal use.
