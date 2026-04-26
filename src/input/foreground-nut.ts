import { keyboard, Key } from '@nut-tree-fork/nut-js'
import type { InputBackend } from './index'

const KEY_MAP: Record<string, string> = {
  ctrl: 'LeftControl',
  shift: 'LeftShift',
  alt: 'LeftAlt',
  page_up: 'PageUp',
  page_down: 'PageDown',
  left: 'Left',
  right: 'Right',
  up: 'Up',
  down: 'Down',
  f1: 'F1',
  f2: 'F2',
  f3: 'F3',
  f4: 'F4',
  f5: 'F5',
  f6: 'F6',
  f7: 'F7',
  f8: 'F8',
  f9: 'F9',
  f10: 'F10',
  f11: 'F11',
  f12: 'F12',
}

function resolve(key: string): string {
  const k = key.toLowerCase()
  if (KEY_MAP[k]) return KEY_MAP[k]
  if (k.length === 1) return k.toUpperCase()
  return key
}

export class ForegroundNutBackend implements InputBackend {
  private held = new Set<string>()

  constructor() {
    keyboard.config.autoDelayMs = 0
  }

  async sendKey(key: string, holdMs: number): Promise<void> {
    const k = resolve(key)
    const KeyAny = Key as unknown as Record<string, number>
    await keyboard.pressKey(KeyAny[k] as unknown as never)
    this.held.add(k)
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs))
    await keyboard.releaseKey(KeyAny[k] as unknown as never)
    this.held.delete(k)
  }

  async sendCombo(keys: string[], interKeyMs = 30): Promise<void> {
    for (const k of keys) {
      await this.sendKey(k, 30)
      if (interKeyMs > 0) await new Promise((r) => setTimeout(r, interKeyMs))
    }
  }

  async sendMove(dir: 'left' | 'right' | 'up' | 'down', ms: number): Promise<void> {
    await this.sendKey(dir, ms)
  }

  async releaseAll(): Promise<void> {
    const KeyAny = Key as unknown as Record<string, number>
    for (const k of [...this.held]) {
      try {
        await keyboard.releaseKey(KeyAny[k] as unknown as never)
      } catch {
        /* ignore */
      }
    }
    this.held.clear()
  }

  canRunBackground(): boolean {
    return false
  }
}
