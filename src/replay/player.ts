import { readFileSync, existsSync } from 'node:fs'
import type { Action } from '@/core/types'
import type { Clock } from '@/core/clock'
import { logger } from '@/core/logger'
import type { Recording, ReplayKeyEvent } from './format'

export interface ReplayPlayerOpts {
  recording: Recording
  clock: Clock
  /** Receives an Action for each event the player decides to fire. The host
   *  routes these through ActionScheduler at priority 'routine' so reflex
   *  pots (priority 'emergency') can preempt them. */
  emit: (a: Action) => void
  /** When true, restart from event 0 after the last event has fired and
   *  durationMs has elapsed. Default true. */
  loop?: boolean
}

interface OpenKey {
  key: string
  pressedAt: number
}

/**
 * Pure-time-replay scheduler. Walks the events list in order and fires each
 * keypress when wall-clock t >= startedAt + event.t. Pairs keydown→keyup
 * into Action{kind:'press', holdMs} so the actuator handles release timing.
 *
 * Drift handling: none. Recorded timeline assumed accurate; if the
 * character drifts (mob knockback, lag), replay continues blind. v1 by
 * design — minimap-anchored variant is a future workstream.
 */
export class ReplayPlayer {
  private recording: Recording
  private clock: Clock
  private emit: (a: Action) => void
  private loop: boolean
  private started = false
  private startedAt = 0
  private nextIdx = 0
  /** keydown events whose matching keyup hasn't been seen yet. Indexed by key. */
  private openKeys = new Map<string, OpenKey>()
  /** Increments each loop iteration; used so we don't re-fire the same event. */
  private loopCount = 0

  constructor(opts: ReplayPlayerOpts) {
    this.recording = opts.recording
    this.clock = opts.clock
    this.emit = opts.emit
    this.loop = opts.loop ?? true
  }

  start(): void {
    this.started = true
    this.startedAt = this.clock.now()
    this.nextIdx = 0
    this.openKeys.clear()
    logger.info(
      {
        events: this.recording.events.length,
        durationMs: this.recording.durationMs,
        loop: this.loop,
      },
      'replay-player: started',
    )
  }

  /** Called from the orchestrator's tick. Drains all events whose recorded
   *  offset has elapsed and converts keydown→keyup pairs into press actions. */
  tick(): void {
    if (!this.started) return
    const elapsed = this.clock.now() - this.startedAt
    const events = this.recording.events

    while (this.nextIdx < events.length && events[this.nextIdx].t <= elapsed) {
      this.consume(events[this.nextIdx], elapsed)
      this.nextIdx++
    }

    // Loop: when past durationMs and at end, restart.
    if (this.nextIdx >= events.length && elapsed >= this.recording.durationMs) {
      if (this.loop) {
        this.loopCount++
        this.startedAt = this.clock.now()
        this.nextIdx = 0
        this.flushOpenKeys()
        logger.info({ loop: this.loopCount }, 'replay-player: looping')
      }
    }
  }

  /** True when not looping AND the recording finished. */
  isDone(): boolean {
    if (this.loop) return false
    if (!this.started) return false
    const elapsed = this.clock.now() - this.startedAt
    return this.nextIdx >= this.recording.events.length && elapsed >= this.recording.durationMs
  }

  private consume(ev: ReplayKeyEvent, _elapsed: number): void {
    if (ev.type === 'keydown') {
      // Stash; we'll fire when we see the matching keyup.
      this.openKeys.set(ev.key, { key: ev.key, pressedAt: ev.t })
    } else {
      // keyup — pair with the matching keydown to compute hold duration.
      const open = this.openKeys.get(ev.key)
      if (!open) {
        // keyup with no matching keydown — orphan. Ignore.
        return
      }
      this.openKeys.delete(ev.key)
      const holdMs = Math.max(1, ev.t - open.pressedAt)
      this.emit({ kind: 'press', key: ev.key, holdMs })
    }
  }

  /** On loop wrap, any in-flight keydowns become orphans. Drop them so the
   *  next loop iteration starts clean. */
  private flushOpenKeys(): void {
    if (this.openKeys.size > 0) {
      logger.warn(
        { unpairedKeys: Array.from(this.openKeys.keys()) },
        'replay-player: flushing unpaired keydowns at loop wrap',
      )
      this.openKeys.clear()
    }
  }
}

/** Read + parse a recording.json. Throws on bad format. */
export function loadRecording(path: string): Recording {
  if (!existsSync(path)) throw new Error(`recording not found: ${path}`)
  const obj = JSON.parse(readFileSync(path, 'utf8'))
  if (obj?.version !== 1) {
    throw new Error(
      `recording version ${obj?.version} not supported (expected 1) at ${path}`,
    )
  }
  if (!Array.isArray(obj.events)) {
    throw new Error(`recording missing events[] at ${path}`)
  }
  return obj as Recording
}
