import { describe, it, expect, vi } from 'vitest'
import { Actuator } from '@/core/actuator'
import type { InputBackend } from '@/input/index'
import { TypedBus } from '@/core/bus'
import { FakeClock } from '@/core/clock'

function fakeBackend(): InputBackend & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    sendKey: vi.fn(async (k, ms) => {
      calls.push(`key:${k}:${ms}`)
    }),
    sendCombo: vi.fn(async (ks) => {
      calls.push(`combo:${ks.join('+')}`)
    }),
    sendMove: vi.fn(async (d, ms) => {
      calls.push(`move:${d}:${ms}`)
    }),
    releaseAll: vi.fn(async () => {
      calls.push('releaseAll')
    }),
    canRunBackground: () => false,
  }
}

describe('Actuator', () => {
  it('sends key when game focused', async () => {
    const be = fakeBackend()
    const bus = new TypedBus()
    const a = new Actuator({
      backend: be,
      bus,
      clock: new FakeClock(),
      getForegroundTitle: async () => 'MapleStory',
      jitterMs: 0,
    })
    a.setTargetWindow('maplestory')
    await a.execute({ kind: 'press', key: 'ctrl' })
    expect(be.calls).toContain('key:ctrl:0')
  })

  it('drops action when game NOT focused', async () => {
    const be = fakeBackend()
    const bus = new TypedBus()
    const a = new Actuator({
      backend: be,
      bus,
      clock: new FakeClock(),
      getForegroundTitle: async () => 'Chrome',
      jitterMs: 0,
    })
    a.setTargetWindow('maplestory')
    await a.execute({ kind: 'press', key: 'ctrl' })
    expect(be.calls).toEqual([])
  })

  it('pause emits event and drops actions until resume', async () => {
    const be = fakeBackend()
    const bus = new TypedBus()
    let paused = false
    bus.on('actuator.pause', () => {
      paused = true
    })
    const a = new Actuator({
      backend: be,
      bus,
      clock: new FakeClock(),
      getForegroundTitle: async () => 'MapleStory',
      jitterMs: 0,
    })
    a.setTargetWindow('maplestory')
    a.pause('user')
    await a.execute({ kind: 'press', key: 'ctrl' })
    expect(be.calls).toEqual([])
    expect(paused).toBe(true)
    a.resume()
    await a.execute({ kind: 'press', key: 'ctrl' })
    expect(be.calls).toContain('key:ctrl:0')
  })

  it('abort releases all keys', async () => {
    const be = fakeBackend()
    const bus = new TypedBus()
    const a = new Actuator({
      backend: be,
      bus,
      clock: new FakeClock(),
      getForegroundTitle: async () => 'MapleStory',
      jitterMs: 0,
    })
    a.setTargetWindow('maplestory')
    a.abort('test')
    expect(be.calls).toContain('releaseAll')
  })
})
