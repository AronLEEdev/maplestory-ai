/**
 * YOLO bounding-box label format.
 *
 *   <class_id> <x_center> <y_center> <width> <height>
 *
 * All four box values are normalized [0, 1] relative to image dimensions.
 * One box per line. Hash comments and blank lines are tolerated when reading
 * but not emitted on write.
 *
 * v2 has two classes; class IDs are stable.
 */

export const CLASS_NAMES = ['player', 'mob'] as const
export type ClassName = (typeof CLASS_NAMES)[number]

export function classIdOf(name: ClassName): number {
  return CLASS_NAMES.indexOf(name)
}
export function classNameOf(id: number): ClassName | null {
  return CLASS_NAMES[id] ?? null
}

export interface YoloBox {
  classId: number
  /** Center x, normalized [0, 1]. */
  cx: number
  /** Center y, normalized [0, 1]. */
  cy: number
  /** Width, normalized [0, 1]. */
  w: number
  /** Height, normalized [0, 1]. */
  h: number
}

/**
 * Pixel-space rect. The labeler hands these over; we convert to/from YOLO
 * normalized form so the canvas code can keep working in pixel coords.
 */
export interface PixelBox {
  classId: number
  x: number
  y: number
  w: number
  h: number
}

export function pixelToYolo(b: PixelBox, imgW: number, imgH: number): YoloBox {
  const cx = (b.x + b.w / 2) / imgW
  const cy = (b.y + b.h / 2) / imgH
  return {
    classId: b.classId,
    cx: clamp01(cx),
    cy: clamp01(cy),
    w: clamp01(b.w / imgW),
    h: clamp01(b.h / imgH),
  }
}

export function yoloToPixel(b: YoloBox, imgW: number, imgH: number): PixelBox {
  const w = b.w * imgW
  const h = b.h * imgH
  return {
    classId: b.classId,
    x: b.cx * imgW - w / 2,
    y: b.cy * imgH - h / 2,
    w,
    h,
  }
}

export function serializeYolo(boxes: YoloBox[]): string {
  return boxes
    .map(
      (b) =>
        `${b.classId} ${b.cx.toFixed(6)} ${b.cy.toFixed(6)} ${b.w.toFixed(6)} ${b.h.toFixed(6)}`,
    )
    .join('\n')
}

export function parseYolo(text: string): YoloBox[] {
  const out: YoloBox[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    if (parts.length !== 5) {
      throw new Error(`yolo: malformed line "${rawLine}" (expected 5 tokens, got ${parts.length})`)
    }
    const classId = Number(parts[0])
    const cx = Number(parts[1])
    const cy = Number(parts[2])
    const w = Number(parts[3])
    const h = Number(parts[4])
    if (
      !Number.isInteger(classId) ||
      [cx, cy, w, h].some((n) => !Number.isFinite(n))
    ) {
      throw new Error(`yolo: malformed numbers in line "${rawLine}"`)
    }
    out.push({ classId, cx, cy, w, h })
  }
  return out
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}
