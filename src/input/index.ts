import { ForegroundNutBackend } from './foreground-nut'

export interface InputBackend {
  sendKey(key: string, holdMs: number): Promise<void>
  sendCombo(keys: string[], interKeyMs: number): Promise<void>
  sendMove(dir: 'left' | 'right' | 'up' | 'down', ms: number): Promise<void>
  releaseAll(): Promise<void>
  canRunBackground(): boolean
}

export { ForegroundNutBackend }

export function createInputBackend(): InputBackend {
  return new ForegroundNutBackend()
}
