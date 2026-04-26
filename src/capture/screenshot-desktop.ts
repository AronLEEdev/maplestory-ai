import screenshot from 'screenshot-desktop'
import sharp from 'sharp'
import type { CaptureProvider } from './index'
import type { Rect } from '@/core/types'

export class ScreenshotDesktopCapture implements CaptureProvider {
  async captureScreen(): Promise<Buffer> {
    const png = await screenshot({ format: 'png' })
    return sharp(png).raw().toBuffer()
  }

  async captureRegion(rect: Rect): Promise<Buffer> {
    const png = await screenshot({ format: 'png' })
    return sharp(png)
      .extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h })
      .raw()
      .toBuffer()
  }

  async captureWindow(_titlePattern: string): Promise<Buffer> {
    return this.captureScreen()
  }

  canCaptureBackground(): boolean {
    return false
  }
}
