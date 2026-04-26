import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { FrameWriter } from './frame-writer'
import type { Clock } from '@/core/clock'

export interface RecorderOpts {
  outDir: string
  name: string
  clock: Clock
  capture: () => Promise<Buffer>
  sampleVitals: () => Promise<{ hp: number; mp: number }>
  framesPerSec: number
}

export interface KeyEvent {
  type: 'keydown' | 'keyup'
  key: string
  t: number
}
export interface SessionMeta {
  resolution: [number, number]
  windowTitle: string
}

export class Recorder {
  private dir: string
  private framesDir: string
  private fw: FrameWriter
  private cancelTimer?: () => void
  private startedAt = 0

  constructor(private opts: RecorderOpts) {
    this.dir = join(opts.outDir, opts.name)
    this.framesDir = join(this.dir, 'frames')
    mkdirSync(this.dir, { recursive: true })
    this.fw = new FrameWriter(this.framesDir)
  }

  async start(meta: SessionMeta): Promise<void> {
    this.startedAt = this.opts.clock.now()
    writeFileSync(
      join(this.dir, 'meta.json'),
      JSON.stringify(
        { ...meta, startedAt: this.startedAt, version: '0.0.1' },
        null,
        2,
      ),
    )
    const periodMs = Math.floor(1000 / this.opts.framesPerSec)
    this.cancelTimer = this.opts.clock.setInterval(() => {
      this.captureOnce().catch(() => {})
    }, periodMs)
  }

  recordKey(ev: KeyEvent): void {
    appendFileSync(join(this.dir, 'inputs.jsonl'), JSON.stringify(ev) + '\n')
  }

  private async captureOnce(): Promise<void> {
    const buf = await this.opts.capture()
    this.fw.write(buf)
    const v = await this.opts.sampleVitals()
    appendFileSync(
      join(this.dir, 'vitals.jsonl'),
      JSON.stringify({ t: this.opts.clock.now() - this.startedAt, ...v }) + '\n',
    )
  }

  async stop(): Promise<void> {
    this.cancelTimer?.()
  }
}
