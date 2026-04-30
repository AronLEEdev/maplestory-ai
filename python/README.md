# Python toolchain (training only)

The runtime is pure TypeScript — Python lives only in this folder, only for
training a YOLO detector and exporting it to ONNX. After export, the TS
runtime loads the `.onnx` directly via `onnxruntime-node`. There is no
Python sidecar at runtime.

## One-time setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt
```

## Per-map workflow

1. **Capture frames** while playing normally:
   ```bash
   npm run dev -- capture henesys --duration 10m --fps 2 --routine routines/henesys.yaml
   ```
   Saves PNGs to `data/dataset/henesys/raw/`.

2. **Label** them in the browser:
   ```bash
   npm run dev -- label henesys
   ```
   Draw boxes around `player` and `mob` instances. Save explicit empty
   labels (hard negatives) on frames with no targets — those teach the
   detector what *isn't* a mob.

3. **Train**:
   ```bash
   python python/train.py henesys --epochs 80 --device mps
   ```
   On Apple Silicon use `--device mps`. Falls back to `cpu` if MPS isn't
   available. ~30-60 min for ~300-500 labeled frames.

4. **Export ONNX**:
   ```bash
   python python/export_onnx.py henesys
   ```
   Writes `data/models/henesys.onnx`.

5. **Wire into the routine** — the calibrator sets
   `perception.model_path: data/models/henesys.onnx` automatically.
   Just `npm run dev -- run routines/henesys.yaml --mode dry-run` to verify
   detections look sane, then `safe`/`live`.

## Class IDs

Stable. **Do not reorder** — the TS side hard-codes them in
`src/dataset/yolo-format.ts`.

| ID | Name   |
|----|--------|
| 0  | player |
| 1  | mob    |

## Hard negatives

If you see false positives at runtime (e.g. a tree decoration getting
boxed as `mob`), capture frames with that tree visible, save them with
explicit empty labels in the labeler (`e` key or "save empty" button),
and retrain. Each hard-negative frame teaches the detector to ignore
that pattern.
