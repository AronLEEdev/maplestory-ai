#!/usr/bin/env python3
"""
Export a fine-tuned YOLO checkpoint to ONNX so the TS runtime can
load it via onnxruntime-node.

Usage:
    python python/export_onnx.py <map> [--imgsz N] [--opset N]

Reads:
    data/dataset/<map>/runs/best.pt   (symlink written by train.py)
        OR
    data/dataset/<map>/runs/train/weights/best.pt

Writes:
    data/models/<map>.onnx

The ONNX file is the only model artifact the runtime needs. Keep it under
version control if you want runs to be reproducible without retraining,
or .gitignore it and rely on a teammate's copy + the dataset.
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
    ap.add_argument('--opset', type=int, default=12)
    ap.add_argument('--simplify', action='store_true', default=True)
    args = ap.parse_args()

    best_pt = find_best_pt(args.map)
    out_path = Path('data') / 'models' / f'{args.map}.onnx'
    out_path.parent.mkdir(parents=True, exist_ok=True)

    from ultralytics import YOLO  # type: ignore

    print(f'loading {best_pt}')
    model = YOLO(str(best_pt))
    print(f'exporting to ONNX (imgsz={args.imgsz}, opset={args.opset})')
    exported = model.export(
        format='onnx',
        imgsz=args.imgsz,
        opset=args.opset,
        simplify=args.simplify,
        dynamic=False,
    )
    print(f'  raw export: {exported}')

    # Ultralytics saves next to the .pt — move/copy to data/models/<map>.onnx.
    src = Path(exported)
    if src.resolve() != out_path.resolve():
        shutil.copy(src, out_path)
    print(f'  copied to : {out_path}')

    print(
        f'\nDone. The runtime will load {out_path} when the routine YAML has '
        f'perception.model_path: {out_path.as_posix()}.'
    )


if __name__ == '__main__':
    main()
