import type {
  PerceptionFrame,
  GameState,
  Action,
  ActionSource,
  ActionPriority,
} from './types'

export type BusEvents = {
  'perception.frame': PerceptionFrame
  'state.built': GameState
  'reflex.vitals': { hp: number; mp: number }
  'action.submitted': { source: ActionSource; action: Action; priority: ActionPriority }
  'action.executed': { action: Action; backend: string; timing: number }
  'action.error': { action: Action; err: unknown }
  'perception.tick': { captureMs: number; detectMs: number; detections: number }
  'actuator.pause': { reason: string }
  'actuator.resume': Record<string, never>
  'actuator.abort': { reason: string }
  'run.mode': { mode: 'dry-run' | 'safe' | 'live' }
}

type Listener<T> = (payload: T) => void

export class TypedBus {
  private listeners: { [K in keyof BusEvents]?: Set<Listener<BusEvents[K]>> } = {}

  on<K extends keyof BusEvents>(ev: K, cb: Listener<BusEvents[K]>) {
    let set = this.listeners[ev] as Set<Listener<BusEvents[K]>> | undefined
    if (!set) {
      set = new Set<Listener<BusEvents[K]>>()
      ;(this.listeners as Record<string, unknown>)[ev as string] = set
    }
    set.add(cb)
  }

  off<K extends keyof BusEvents>(ev: K, cb: Listener<BusEvents[K]>) {
    const set = this.listeners[ev] as Set<Listener<BusEvents[K]>> | undefined
    set?.delete(cb)
  }

  emit<K extends keyof BusEvents>(ev: K, payload: BusEvents[K]) {
    const set = this.listeners[ev] as Set<Listener<BusEvents[K]>> | undefined
    set?.forEach((cb) => cb(payload))
  }
}
