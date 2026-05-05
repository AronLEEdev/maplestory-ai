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

  it('resolves global-key-listener names (left ctrl, left arrow, etc.) to nut.js keys', async () => {
    const b = new ForegroundNutBackend()
    const nut = await import('@nut-tree-fork/nut-js')
    const cases: Array<[string, string]> = [
      ['left ctrl', 'LeftControl'],
      ['LEFT CTRL', 'LeftControl'],
      ['right shift', 'RightShift'],
      ['left arrow', 'Left'],
      ['right arrow', 'Right'],
      ['up arrow', 'Up'],
      ['down arrow', 'Down'],
      ['space', 'Space'],
    ]
    for (const [input, expectedKey] of cases) {
      ;(nut.keyboard.pressKey as ReturnType<typeof vi.fn>).mockClear()
      await b.sendKey(input, 0)
      const calls = (nut.keyboard.pressKey as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.length, `pressKey called for ${input}`).toBe(1)
      expect(calls[0][0], `${input} resolved`).toBe(expectedKey)
    }
  })
})
