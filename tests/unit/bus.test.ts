import { describe, it, expect } from 'vitest'
import { TypedBus } from '@/core/bus'

describe('TypedBus', () => {
  it('delivers events to subscribers', () => {
    const bus = new TypedBus()
    const received: number[] = []
    bus.on('reflex.vitals', (p) => received.push(p.hp))
    bus.emit('reflex.vitals', { hp: 0.5, mp: 0.7 })
    expect(received).toEqual([0.5])
  })

  it('supports multiple subscribers', () => {
    const bus = new TypedBus()
    let a = 0,
      b = 0
    bus.on('reflex.vitals', () => a++)
    bus.on('reflex.vitals', () => b++)
    bus.emit('reflex.vitals', { hp: 1, mp: 1 })
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  it('off removes subscriber', () => {
    const bus = new TypedBus()
    let count = 0
    const cb = () => count++
    bus.on('reflex.vitals', cb)
    bus.off('reflex.vitals', cb)
    bus.emit('reflex.vitals', { hp: 1, mp: 1 })
    expect(count).toBe(0)
  })
})
