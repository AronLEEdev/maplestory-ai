import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Recorder } from '@/recorder/index'
import { FakeClock } from '@/core/clock'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rec-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Recorder', () => {
  it('writes frames + inputs.jsonl + vitals.jsonl + meta.json', async () => {
    const clock = new FakeClock(0)
    const r = new Recorder({
      outDir: root,
      name: 'test',
      clock,
      capture: async () => Buffer.from([0]),
      sampleVitals: async () => ({ hp: 0.5, mp: 0.7 }),
      framesPerSec: 5,
    })
    await r.start({ resolution: [1920, 1080], windowTitle: 'MapleStory' })
    r.recordKey({ type: 'keydown', key: 'ctrl', t: 100 })
    await r.stop()
    const dir = join(root, 'test')
    expect(existsSync(join(dir, 'meta.json'))).toBe(true)
    expect(existsSync(join(dir, 'inputs.jsonl'))).toBe(true)
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    expect(meta.windowTitle).toBe('MapleStory')
  })

  it('touches empty inputs.jsonl + vitals.jsonl on start (so analyzer never ENOENTs)', async () => {
    const clock = new FakeClock(0)
    const r = new Recorder({
      outDir: root,
      name: 'empty',
      clock,
      capture: async () => Buffer.from([0]),
      sampleVitals: async () => ({ hp: 1, mp: 1 }),
      framesPerSec: 5,
    })
    await r.start({ resolution: [1920, 1080], windowTitle: 'MapleStory' })
    await r.stop()
    const dir = join(root, 'empty')
    expect(existsSync(join(dir, 'inputs.jsonl'))).toBe(true)
    expect(existsSync(join(dir, 'vitals.jsonl'))).toBe(true)
  })

  it('captures errors via onCaptureError callback', async () => {
    const errors: unknown[] = []
    const clock = new FakeClock(0)
    const r = new Recorder({
      outDir: root,
      name: 'cap-err',
      clock,
      capture: async () => {
        throw new Error('display lost')
      },
      sampleVitals: async () => ({ hp: 1, mp: 1 }),
      framesPerSec: 5,
      onCaptureError: (e) => errors.push(e),
    })
    await r.start({ resolution: [1920, 1080], windowTitle: 'MapleStory' })
    // Advance fake clock past first capture interval (1000/5 = 200ms)
    clock.tick(250)
    // Yield so the captureOnce promise rejects and onCaptureError fires
    await new Promise((res) => setImmediate(res))
    await r.stop()
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect((errors[0] as Error).message).toBe('display lost')
  })
})
