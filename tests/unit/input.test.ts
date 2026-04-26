import { describe, it, expect, vi } from 'vitest'
import { ForegroundNutBackend } from '@/input/foreground-nut'

vi.mock('@nut-tree-fork/nut-js', () => ({
  keyboard: {
    config: { autoDelayMs: 0 },
    pressKey: vi.fn(async () => {}),
    releaseKey: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
  },
  Key: new Proxy({}, { get: (_t, name) => name }),
}))

describe('ForegroundNutBackend', () => {
  it('sendKey calls press then release', async () => {
    const b = new ForegroundNutBackend()
    await b.sendKey('a', 50)
    const nut = await import('@nut-tree-fork/nut-js')
    expect(nut.keyboard.pressKey).toHaveBeenCalled()
    expect(nut.keyboard.releaseKey).toHaveBeenCalled()
  })

  it('canRunBackground returns false', () => {
    const b = new ForegroundNutBackend()
    expect(b.canRunBackground()).toBe(false)
  })
})
