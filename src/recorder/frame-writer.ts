import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export class FrameWriter {
  private idx = 0
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }
  write(buf: Buffer): string {
    const name = `${String(this.idx++).padStart(6, '0')}.png`
    writeFileSync(join(this.dir, name), buf)
    return name
  }
}
