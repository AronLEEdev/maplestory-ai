import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReplayWriter } from '@/replay/writer'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'replay-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ReplayWriter', () => {
  it('writes JSONL entries', async () => {
    const w = new ReplayWriter(dir)
    await w.write('actions', { t: 0, kind: 'press', key: 'ctrl' })
    await w.write('actions', { t: 100, kind: 'press', key: 'shift' })
    await w.close()
    const text = readFileSync(join(dir, 'actions.jsonl'), 'utf8')
    expect(text.trim().split('\n').length).toBe(2)
  })
})
