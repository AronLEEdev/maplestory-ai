/**
 * SpriteSource — pluggable interface for fetching mob sprite data.
 *
 * v1.2 ships ZERO concrete implementations. The interface is defined here so
 * that v1.3+ can add sources (maplestory.io HTTP API, local WZ extraction,
 * MapleStory Worlds CDN, etc.) without touching the runtime path.
 *
 * The runtime DOES NOT depend on a SpriteSource. Manual `import-sprites` is
 * the v1.2 path; this file is scaffolding for future automation only.
 */

export interface MobRef {
  /** Canonical ID per source (e.g. "0100100" for GMS Snail). */
  id: string
  name?: string
  /** Region tag — 'gms' | 'msea' | 'kms' | 'jms' | 'tms' | 'worlds' | ... */
  region: string
}

export interface MobSpriteVariant {
  variant: string // 'idle' | 'move' | 'attack' | ...
  png: Buffer
  /** Original bbox in the source image, if known. */
  bbox?: [number, number, number, number]
}

export interface MobSpriteSet {
  ref: MobRef
  variants: MobSpriteVariant[]
}

export interface SourceCapabilities {
  /** Source can resolve a map ID to its mob spawn list. */
  supportsMapLookup: boolean
  /** Source can fetch sprite PNGs given a MobRef. */
  supportsMobLookup: boolean
  /** Regions this source covers — e.g. ['gms', 'msea']. */
  regions: string[]
}

export interface SpriteSource {
  readonly id: string
  capabilities(): SourceCapabilities
  listMobsOnMap?(mapId: string): Promise<MobRef[]>
  getMobSprites?(mob: MobRef): Promise<MobSpriteSet>
}

/**
 * Placeholder no-op source so type-import sites compile. Returns empty
 * capabilities. Useful as a default during testing or when the user has not
 * configured any source.
 */
export class NullSpriteSource implements SpriteSource {
  readonly id = 'null'
  capabilities(): SourceCapabilities {
    return { supportsMapLookup: false, supportsMobLookup: false, regions: [] }
  }
}
