import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { logger } from '@/core/logger'
import type { Recording, ReplayKeyEvent } from './format'

export interface ReplayRecorderOpts {
  map: string
  windowTitle: string
  outPath: string
  /** Filter out keys we never want recorded (e.g. F12 abort hotkey). */
  ignoreKeys?: string[]
}

/**
 * Captures keypresses with millisecond timestamps. Persists to a single
 * recording.json file when stop() is called. No frames, no vitals — purely
 * the input timeline. The reflex worker handles HP/MP independently at
 * runtime so recorded pots would be redundant; we drop them.
 */
export class ReplayRecorder {
  private startedAt = 0
  private events: ReplayKeyEvent[] = []
  private ignore: Set<string>
  private opts: ReplayRecorderOpts

  constructor(opts: ReplayRecorderOpts) {
    this.opts = opts
    this.ignore = new Set((opts.ignoreKeys ?? []).map((k) => k.toLowerCase()))
  }

  start(): void {
    this.startedAt = Date.now()
    this.events = []
    logger.info({ map: this.opts.map, outPath: this.opts.outPath }, 'replay-recorder: started')
  }

  recordKey(type: 'keydown' | 'keyup', rawKey: string): void {
    const key = String(rawKey).toLowerCase()
    if (this.ignore.has(key)) return
    this.events.push({ t: Date.now() - this.startedAt, type, key })
  }

  stop(): Recording {
    const durationMs = Date.now() - this.startedAt
    const recording: Recording = {
      version: 1,
      map: this.opts.map,
      recordedAt: new Date(this.startedAt).toISOString(),
      durationMs,
      windowTitle: this.opts.windowTitle,
      events: this.events,
    }
    mkdirSync(dirname(this.opts.outPath), { recursive: true })
    writeFileSync(this.opts.outPath, JSON.stringify(recording, null, 2))
    logger.info(
      {
        outPath: this.opts.outPath,
        events: this.events.length,
        durationMs,
      },
      'replay-recorder: saved',
    )
    return recording
  }
}
