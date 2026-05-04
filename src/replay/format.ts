/**
 * Replay recording format. Self-contained JSON bundle:
 *   replays/<map>/recording.json
 *
 * Single file (vs the multi-file recordings/<name>/ used by the analyze
 * pipeline) so it can be moved/shared trivially. Reflex inputs are NOT
 * stored — the runtime's reflex worker fires pots in parallel with replay,
 * so recorded pot keys would just duplicate what the reflex layer does.
 */

export interface ReplayKeyEvent {
  /** Milliseconds from recording start. */
  t: number
  type: 'keydown' | 'keyup'
  /** nut.js-compatible key name (matches what record-replay captures from
   *  node-global-key-listener and what InputBackend.sendKey accepts). */
  key: string
}

export interface Recording {
  /** Schema version — bumped on incompatible format changes. */
  version: 1
  map: string
  /** ISO 8601 timestamp of recording start. */
  recordedAt: string
  /** Total duration ms, used for loop wrap. */
  durationMs: number
  /** Window title at record time, for sanity-check matching at replay. */
  windowTitle: string
  events: ReplayKeyEvent[]
}

export function emptyRecording(map: string, windowTitle: string): Recording {
  return {
    version: 1,
    map,
    recordedAt: new Date().toISOString(),
    durationMs: 0,
    windowTitle,
    events: [],
  }
}
