import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

export type ReplayChannel = 'perception' | 'states' | 'actions' | 'events'

export class ReplayWriter {
  private streams = new Map<ReplayChannel, WriteStream>()

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private get(channel: ReplayChannel): WriteStream {
    if (!this.streams.has(channel)) {
      this.streams.set(
        channel,
        createWriteStream(join(this.dir, `${channel}.jsonl`), { flags: 'a' }),
      )
    }
    return this.streams.get(channel)!
  }

  write(channel: ReplayChannel, entry: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      this.get(channel).write(JSON.stringify(entry) + '\n', (err) =>
        err ? reject(err) : resolve(),
      )
    })
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.streams.values()].map(
        (s) => new Promise<void>((r) => s.end(() => r())),
      ),
    )
    this.streams.clear()
  }
}
