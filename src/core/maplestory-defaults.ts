import type { Rect } from './types'

/**
 * Default Maplestory UI regions per common resolutions.
 * Used by `record` when no calibrated routine is supplied.
 */
export interface MaplestoryRegions {
  hp: Rect
  mp: Rect
  minimap: Rect
}

const REGIONS_1920x1080: MaplestoryRegions = {
  hp: { x: 820, y: 1000, w: 140, h: 14 },
  mp: { x: 966, y: 1000, w: 140, h: 14 },
  minimap: { x: 1820, y: 14, w: 80, h: 60 },
}

const REGIONS_1366x768: MaplestoryRegions = {
  hp: { x: 583, y: 711, w: 100, h: 10 },
  mp: { x: 687, y: 711, w: 100, h: 10 },
  minimap: { x: 1280, y: 10, w: 60, h: 45 },
}

export function defaultRegions(width: number, height: number): MaplestoryRegions {
  if (width === 1366 && height === 768) return REGIONS_1366x768
  // Fall back to 1920x1080 — the most common Maplestory resolution.
  return REGIONS_1920x1080
}
