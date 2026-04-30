#!/usr/bin/env python3
"""
Fine-tune YOLOv8n on a per-map maplestory.ai dataset.

Usage:
    python python/train.py <map> [--epochs N] [--imgsz N] [--device cpu|mps|cuda]

Reads:
    data/dataset/<map>/raw/*.png
    data/dataset/<map>/labels/*.txt   (YOLO format: class cx cy w h normalized)

Writes:
    data/dataset/<map>/data.yaml      (auto-generated split + class names)
    data/dataset/<map>/runs/...        (Ultralytics run dir with weights)
    data/dataset/<map>/runs/best.pt   (symlinked to the best checkpoint)

Then run python/export_onnx.py <map> to convert best.pt -> data/models/<map>.onnx.
"""
from __future__ import annotations

import argparse
import os
import random
import shutil
import sys
from pathlib import Path

CLASS_NAMES = ['player', 'mob']  # MUST match src/dataset/yolo-format.ts


def split_dataset(dataset_dir: Path, val_frac: float = 0.15, seed: int = 42) -> tuple[Path, Path]:
    """
    Ultralytics expects train/val image lists. We lay out:
        <dataset_dir>/images/train/*.png
        <dataset_dir>/images/val/*.png
        <dataset_dir>/labels/train/*.txt
        <dataset_dir>/labels/val/*.txt

    Frames without a label file are SKIPPED — only labeled frames go in.
    """
    raw = dataset_dir / 'raw'
    labels = dataset_dir / 'labels'
    if not raw.is_dir():
        sys.exit(f'no raw frames at {raw} — run `capture <map>` first')
    if not labels.is_dir():
        sys.exit(f'no labels at {labels} — run `label <map>` first')

    pairs = []
    for png in sorted(raw.glob('*.png')):
        txt = labels / (png.stem + '.txt')
        if txt.exists():
            pairs.append((png, txt))
    if not pairs:
        sys.exit(f'no labeled frames found in {dataset_dir}')

    random.seed(seed)
    random.shuffle(pairs)
    n_val = max(1, int(len(pairs) * val_frac))
    val_pairs = pairs[:n_val]
    train_pairs = pairs[n_val:]

    images_train = dataset_dir / 'images' / 'train'
    images_val = dataset_dir / 'images' / 'val'
    labels_train = dataset_dir / 'labels' / 'train'
    labels_val = dataset_dir / 'labels' / 'val'
    for d in (images_train, images_val, labels_train, labels_val):
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True, exist_ok=True)

    def link_pair(pair, img_dst: Path, lbl_dst: Path) -> None:
        img_src, lbl_src = pair
        img_target = img_dst / img_src.name
        lbl_target = lbl_dst / lbl_src.name
        # Symlink to keep raw/ as the source of truth; the user can re-label
        # in raw/labels and re-run train without re-copying.
        try:
            if img_target.exists():
                img_target.unlink()
            os.symlink(img_src.resolve(), img_target)
            if lbl_target.exists():
                lbl_target.unlink()
            os.symlink(lbl_src.resolve(), lbl_target)
        except OSError:
            shutil.copy(img_src, img_target)
            shutil.copy(lbl_src, lbl_target)

    for p in train_pairs:
        link_pair(p, images_train, labels_train)
    for p in val_pairs:
        link_pair(p, images_val, labels_val)

    print(f'split: {len(train_pairs)} train, {len(val_pairs)} val')
    return images_train, images_val


def write_data_yaml(dataset_dir: Path) -> Path:
    yaml_path = dataset_dir / 'data.yaml'
    yaml_path.write_text(
        '\n'.join(
            [
                f'path: {dataset_dir.resolve()}',
                'train: images/train',
                'val: images/val',
                f'nc: {len(CLASS_NAMES)}',
                f'names: {CLASS_NAMES}',
                '',
            ]
        )
    )
    return yaml_path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('map', help='map name (e.g. henesys)')
    ap.add_argument('--epochs', type=int, default=None)
    ap.add_argument('--imgsz', type=int, default=640)
    ap.add_argument('--batch', type=int, default=16)
    ap.add_argument('--device', default='mps', help='cpu | mps | cuda')
    ap.add_argument('--model', default='yolov8n.pt', help='COCO-pretrained start')
    ap.add_argument(
        '--quick',
        action='store_true',
        help='quick bootstrap pass (20 epochs) for model-assisted labeling. '
             'After labeling another batch with the predictions, retrain '
             'without --quick for the final model.',
    )
    args = ap.parse_args()
    # --epochs explicit wins; --quick → 20; default → 80.
    if args.epochs is None:
        args.epochs = 20 if args.quick else 80

    dataset_dir = Path('data') / 'dataset' / args.map
    if not dataset_dir.is_dir():
        sys.exit(f'dataset not found at {dataset_dir}')

    split_dataset(dataset_dir)
    yaml_path = write_data_yaml(dataset_dir)

    # Lazy import — keeps `--help` instant and the script importable in tests.
    from ultralytics import YOLO  # type: ignore

    runs_dir = dataset_dir / 'runs'
    runs_dir.mkdir(exist_ok=True)

    model = YOLO(args.model)
    print(
        f'fine-tuning {args.model} on {yaml_path} '
        f'for {args.epochs} epochs at {args.imgsz}px on device={args.device}'
    )
    results = model.train(
        data=str(yaml_path),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        project=str(runs_dir),
        name='train',
        exist_ok=True,
        plots=True,
    )
    print('training done')
    print(f'  best.pt   : {results.save_dir}/weights/best.pt')
    print(f'  metrics   : {results.save_dir}/results.png')

    # Stable symlink so export_onnx.py can find the latest best.pt.
    best_link = runs_dir / 'best.pt'
    best_pt = Path(results.save_dir) / 'weights' / 'best.pt'
    try:
        if best_link.exists() or best_link.is_symlink():
            best_link.unlink()
        os.symlink(best_pt.resolve(), best_link)
        print(f'  symlink   : {best_link} -> {best_pt}')
    except OSError as e:
        print(f'  WARN: symlink failed ({e}); use {best_pt} directly with export_onnx')


if __name__ == '__main__':
    main()
