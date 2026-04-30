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

## Per-map workflow (model-assisted, ~3-5× faster than scratch)

1. **Capture frames** while playing normally:
   ```bash
   npm run dev -- capture henesys --duration 10m --fps 2 --routine routines/henesys.yaml
   ```
   Saves PNGs to `data/dataset/henesys/raw/`.

2. **Label a small bootstrap set** (~30-50 frames, ~15-20 min):
   ```bash
   npm run dev -- label henesys
   ```
   Draw player + mob boxes manually on the first batch. Mix in a few
   "hard negatives" (frames with no target — press `e` to save empty)
   so the detector learns what *isn't* a mob.

3. **Quick-train a bootstrap model** (~10 min on M4):
   ```bash
   python python/train.py henesys --quick
   python python/export_onnx.py henesys
   ```
   `--quick` is 20 epochs — enough for a weak-but-useful detector that
   speeds up the next labeling pass.

4. **Label the rest, model-assisted**:
   ```bash
   npm run dev -- label henesys
   ```
   The **predict** button (or `p` key) now runs YOLO on each frame and
   pre-fills suggestion boxes (orange dashed). Click a box to edit it,
   delete bad ones, draw new ones the model missed, hit save. Each
   frame takes seconds instead of ~20 seconds.

5. **Train the final model** with the full dataset:
   ```bash
   python python/train.py henesys           # 80 epochs by default
   python python/export_onnx.py henesys
   ```

6. **Run the bot**:
   ```bash
   npm run dev -- run routines/henesys.yaml --mode dry-run
   npm run dev -- run routines/henesys.yaml --mode safe
   npm run dev -- run routines/henesys.yaml --mode live
   ```

If detections still miss, capture more frames covering the missing
cases (different mob species, attack effects on screen, jumping,
crowded scenes), label them with model assistance, and retrain.

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
