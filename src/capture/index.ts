import type { Rect } from '@/core/types'
import { ScreenshotDesktopCapture } from './screenshot-desktop'

export interface CaptureProvider {
  captureScreen(): Promise<Buffer>
  captureRegion(rect: Rect): Promise<Buffer>
  captureWindow(titlePattern: string): Promise<Buffer>
  canCaptureBackground(): boolean
}

export { ScreenshotDesktopCapture }

export function createCaptureProvider(): CaptureProvider {
  return new ScreenshotDesktopCapture()
}
