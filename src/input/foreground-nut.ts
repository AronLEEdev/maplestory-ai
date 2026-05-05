import { keyboard, Key } from '@nut-tree-fork/nut-js'
import type { InputBackend } from './index'
import { logger } from '@/core/logger'

/**
 * Resolve user-friendly key names to nut.js's Key-enum member names.
 *
 * Surprises baked into nut.js (which is why this map matters):
 *   - Top-row digits are `Num0`..`Num9`, NOT `0`..`9`.
 *   - Numpad digits are `NumPad0`..`NumPad9`.
 *   - Punctuation (`-`, `=`, `[`, `]`, `;`, `'`, `,`, `.`, `/`, `\\`) needs
 *     explicit symbolic names (Minus, Equal, LeftBracket, ...).
 *   - Letters work via uppercase ('A' → Key.A).
 *   - F-keys are 'F1'..'F12'.
 */
const KEY_MAP: Record<string, string> = {
  // Modifiers — short forms
  ctrl: 'LeftControl',
  control: 'LeftControl',
  shift: 'LeftShift',
  alt: 'LeftAlt',
  cmd: 'LeftCmd',
  command: 'LeftCmd',
  meta: 'LeftCmd',
  // Modifiers — node-global-key-listener naming (record-replay mode)
  'left ctrl': 'LeftControl',
  'right ctrl': 'RightControl',
  'left shift': 'LeftShift',
  'right shift': 'RightShift',
  'left alt': 'LeftAlt',
  'right alt': 'RightAlt',
  'left meta': 'LeftCmd',
  'right meta': 'RightCmd',
  // Navigation
  page_up: 'PageUp',
  pageup: 'PageUp',
  'page up': 'PageUp',
  page_down: 'PageDown',
  pagedown: 'PageDown',
  'page down': 'PageDown',
  home: 'Home',
  end: 'End',
  insert: 'Insert',
  delete: 'Delete',
  backspace: 'Backspace',
  tab: 'Tab',
  enter: 'Enter',
  return: 'Return',
  escape: 'Escape',
  esc: 'Escape',
  space: 'Space',
  // Arrows — short forms
  left: 'Left',
  right: 'Right',
  up: 'Up',
  down: 'Down',
  // Arrows — node-global-key-listener naming
  'left arrow': 'Left',
  'right arrow': 'Right',
  'up arrow': 'Up',
  'down arrow': 'Down',
  // F-keys
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4',
  f5: 'F5', f6: 'F6', f7: 'F7', f8: 'F8',
  f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',
  // Top-row digits — nut.js calls these `Num0`..`Num9`
  '0': 'Num0', '1': 'Num1', '2': 'Num2', '3': 'Num3', '4': 'Num4',
  '5': 'Num5', '6': 'Num6', '7': 'Num7', '8': 'Num8', '9': 'Num9',
  // Punctuation
  '-': 'Minus', '=': 'Equal',
  '[': 'LeftBracket', ']': 'RightBracket',
  ';': 'Semicolon', "'": 'Quote',
  ',': 'Comma', '.': 'Period', '/': 'Slash',
  '\\': 'Backslash', '`': 'Grave',
}

function resolve(key: string): string {
  if (KEY_MAP[key]) return KEY_MAP[key]
  const k = key.toLowerCase()
  if (KEY_MAP[k]) return KEY_MAP[k]
  if (k.length === 1) {
    // letters → 'A'..'Z' (Key.A is defined)
    return k.toUpperCase()
  }
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
    const code = KeyAny[k]
    if (code === undefined) {
      logger.warn(
        { requested: key, resolved: k, availableSample: Object.keys(Key).slice(0, 20) },
        'sendKey: unknown nut.js Key — nothing pressed',
      )
      return
    }
    await keyboard.pressKey(code as unknown as never)
    this.held.add(k)
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs))
    await keyboard.releaseKey(code as unknown as never)
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
