import { describe, it, expect, vi } from 'vitest'
import { ScreenshotDesktopCapture } from '@/capture/screenshot-desktop'

vi.mock('screenshot-desktop', () => ({
  default: vi.fn(async () => Buffer.from([0xff, 0x00, 0x00, 0xff])),
}))
vi.mock('sharp', () => {
  const mock = (): unknown => ({
    extract: vi.fn(() => mock()),
    raw: vi.fn(() => mock()),
    toBuffer: vi.fn(async () => Buffer.from([0xff, 0x00, 0x00, 0xff])),
    metadata: vi.fn(async () => ({ width: 100, height: 100, channels: 4 })),
  })
  return { default: mock }
})

describe('ScreenshotDesktopCapture', () => {
  it('captureScreen returns Buffer', async () => {
    const c = new ScreenshotDesktopCapture()
    const buf = await c.captureScreen()
    expect(Buffer.isBuffer(buf)).toBe(true)
  })

  it('canCaptureBackground returns false in v1', () => {
    const c = new ScreenshotDesktopCapture()
    expect(c.canCaptureBackground()).toBe(false)
  })
})
