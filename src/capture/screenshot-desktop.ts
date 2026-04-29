import screenshot from 'screenshot-desktop'
import sharp from 'sharp'
import type { CaptureProvider } from './index'
import type { Rect } from '@/core/types'
import { activateApplication } from '@/core/focus'

export class ScreenshotDesktopCapture implements CaptureProvider {
  /**
   * Returns a PNG-encoded buffer of the full display.
   */
  async captureScreen(): Promise<Buffer> {
    const png = await screenshot({ format: 'png' })
    return Buffer.isBuffer(png) ? png : Buffer.from(png as unknown as ArrayBufferLike)
  }

  /**
   * Returns raw RGB pixels for the requested region. The Reflex pixel sampler
   * and template-match haystack consume raw RGB.
   */
  async captureRegion(rect: Rect): Promise<Buffer> {
    const png = await screenshot({ format: 'png' })
    return sharp(png)
      .extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h })
      .removeAlpha()
      .raw()
      .toBuffer()
  }

  /**
   * Bring the target window to front (handles cross-Space switching on macOS),
   * wait for the animation, then capture the full display.
   * Works cross-platform: osascript on macOS, PowerShell on Windows.
   */
  async captureWindow(titlePattern: string): Promise<Buffer> {
    await activateApplication(titlePattern)
    await new Promise((r) => setTimeout(r, 1500))
    return this.captureScreen()
  }

  canCaptureBackground(): boolean {
    return false
  }
}
