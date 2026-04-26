export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
  setInterval(fn: () => void, ms: number): () => void
}

export class RealClock implements Clock {
  now() {
    return Date.now()
  }
  sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms))
  }
  setInterval(fn: () => void, ms: number) {
    const h = setInterval(fn, ms)
    return () => clearInterval(h)
  }
}

interface PendingSleep {
  wakeAt: number
  resolve: () => void
}
interface PendingInterval {
  every: number
  nextAt: number
  fn: () => void
  cancelled: boolean
}

export class FakeClock implements Clock {
  private t: number
  private sleeps: PendingSleep[] = []
  private intervals: PendingInterval[] = []
  constructor(start = 0) {
    this.t = start
  }

  now() {
    return this.t
  }

  sleep(ms: number) {
    return new Promise<void>((resolve) => {
      this.sleeps.push({ wakeAt: this.t + ms, resolve })
    })
  }

  setInterval(fn: () => void, ms: number) {
    const i: PendingInterval = { every: ms, nextAt: this.t + ms, fn, cancelled: false }
    this.intervals.push(i)
    return () => {
      i.cancelled = true
    }
  }

  tick(ms: number) {
    const target = this.t + ms
    while (this.t < target) {
      const nextSleep = this.sleeps.length
        ? Math.min(...this.sleeps.map((s) => s.wakeAt))
        : Infinity
      const liveIntervals = this.intervals.filter((i) => !i.cancelled)
      const nextIntv = liveIntervals.length
        ? Math.min(...liveIntervals.map((i) => i.nextAt))
        : Infinity
      const next = Math.min(nextSleep, nextIntv, target)
      this.t = next
      const due = this.sleeps.filter((s) => s.wakeAt <= this.t)
      this.sleeps = this.sleeps.filter((s) => s.wakeAt > this.t)
      due.forEach((s) => s.resolve())
      for (const iv of this.intervals) {
        while (!iv.cancelled && iv.nextAt <= this.t) {
          iv.fn()
          iv.nextAt += iv.every
        }
      }
    }
  }
}
