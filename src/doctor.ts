import { existsSync } from 'node:fs'
import chalk from 'chalk'
import { ScreenshotDesktopCapture } from '@/capture/screenshot-desktop'
import { ForegroundNutBackend } from '@/input/foreground-nut'
import { getForegroundWindowTitle } from '@/core/focus'

export async function runDoctor(): Promise<number> {
  let ok = true
  const pass = (m: string) => console.log(chalk.green('✓'), m)
  const fail = (m: string) => {
    console.log(chalk.red('✗'), m)
    ok = false
  }
  const warn = (m: string) => console.log(chalk.yellow('!'), m)

  const major = Number(process.versions.node.split('.')[0])
  if (major >= 20) pass(`Node ${process.versions.node}`)
  else fail(`Node 20+ required, found ${process.versions.node}`)

  pass(`Platform: ${process.platform}-${process.arch}`)

  try {
    const t0 = Date.now()
    await new ScreenshotDesktopCapture().captureScreen()
    pass(`Capture latency: ${Date.now() - t0} ms`)
  } catch (e) {
    fail(`Capture failed: ${(e as Error).message}`)
  }

  try {
    new ForegroundNutBackend()
    pass('nut.js loaded')
  } catch (e) {
    fail(`nut.js failed: ${(e as Error).message}`)
  }

  if (process.env.ANTHROPIC_API_KEY) pass('ANTHROPIC_API_KEY set')
  else warn('ANTHROPIC_API_KEY not set (needed for analyze)')

  if (!existsSync('models/yolov8n-maplestory.onnx'))
    warn('models/yolov8n-maplestory.onnx missing — fetch via release')
  else pass('YOLO model present')

  const fg = await getForegroundWindowTitle()
  if (fg && fg.toLowerCase().includes('maplestory')) pass(`Maplestory focused: ${fg}`)
  else warn('Maplestory window not currently focused (optional)')

  return ok ? 0 : 1
}
