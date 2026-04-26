import { GlobalKeyboardListener } from 'node-global-key-listener'

export interface HotkeyHandlers {
  onPauseToggle: () => void
  onAbort: () => void
  onMark?: () => void
}

export class HotkeyService {
  private listener: GlobalKeyboardListener
  private handlers: HotkeyHandlers

  constructor(handlers: HotkeyHandlers) {
    this.listener = new GlobalKeyboardListener()
    this.handlers = handlers
  }

  start(): void {
    this.listener.addListener((e) => {
      if (e.state !== 'DOWN') return
      if (e.name === 'F10') this.handlers.onPauseToggle()
      else if (e.name === 'F12') this.handlers.onAbort()
      else if (e.name === 'F9' && this.handlers.onMark) this.handlers.onMark()
    })
  }

  stop(): void {
    this.listener.kill()
  }
}
