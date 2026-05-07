#!/usr/bin/env python3
"""
Export a fine-tuned YOLO checkpoint to CoreML (.mlpackage) so the Swift
sidecar can run it on the Neural Engine via Vision/CoreML APIs.

Usage:
    python python/export_coreml.py <map> [--imgsz N] [--nms]

Reads:
    data/dataset/<map>/runs/best.pt          (symlink from train.py)
        OR
    data/dataset/<map>/runs/train/weights/best.pt

Writes:
    data/models/<map>.mlpackage              (directory bundle)

The .mlpackage is what the Swift sidecar's Inference module loads. The
.onnx export (export_onnx.py) is still produced for the legacy Node-side
onnxruntime-node path; both can coexist.

Ultralytics' coreml exporter wraps the model with NMS by default at
imgsz=640. Pass --no-nms if you want raw box outputs and intend to run
NMS in Swift (the sidecar already has Swift NMS in task 6, so --no-nms
is the production setting).
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path


def find_best_pt(map_name: str) -> Path:
    runs = Path('data') / 'dataset' / map_name / 'runs'
    direct = runs / 'best.pt'
    if direct.exists():
        return direct
    fallback = runs / 'train' / 'weights' / 'best.pt'
    if fallback.exists():
        return fallback
    sys.exit(
        f'no best.pt found under {runs}/. '
        f'Run `python python/train.py {map_name}` first.'
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('map')
    ap.add_argument('--imgsz', type=int, default=640)
    ap.add_argument(
        '--nms',
        action='store_true',
        default=False,
        help='bake NMS into the .mlpackage. Default off — the Swift sidecar '
             'runs its own NMS so production exports skip this.',
    )
    args = ap.parse_args()

    best_pt = find_best_pt(args.map)
    out_dir = Path('data') / 'models' / f'{args.map}.mlpackage'
    out_dir.parent.mkdir(parents=True, exist_ok=True)

    from ultralytics import YOLO  # type: ignore

    print(f'loading {best_pt}')
    model = YOLO(str(best_pt))
    print(f'exporting to CoreML (imgsz={args.imgsz}, nms={args.nms})')
    exported = model.export(
        format='coreml',
        imgsz=args.imgsz,
        nms=args.nms,
        # half=True would emit a float16 model — smaller + faster on Neural
        # Engine. Defer until task 4 verifies fp32 works first.
        half=False,
    )
    print(f'  raw export: {exported}')

    # Ultralytics writes either a .mlmodel (older) or a .mlpackage dir
    # (newer). Move/copy to data/models/<map>.mlpackage.
    src = Path(exported)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    if src.is_dir():
        shutil.copytree(src, out_dir)
    else:
        # .mlmodel single-file export — wrap in a package-like dir.
        out_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy(src, out_dir / src.name)
    print(f'  copied to : {out_dir}')

    print(
        f'\nDone. The Swift sidecar loads this via:\n'
        f'  PerceptionSidecar --model {out_dir.as_posix()} --game-window x,y,w,h\n'
    )


if __name__ == '__main__':
    main()
