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

  if (process.env.ANTHROPIC_API_KEY) pass('ANTHROPIC_API_KEY set (only needed for `analyze --api`)')
  else warn('ANTHROPIC_API_KEY not set (only matters for `analyze --api`; default Claude Code path needs no key)')

  if (existsSync('data/templates')) pass('data/templates dir present')
  else warn('data/templates missing — run `import-sprites <map>` after dropping sprites into data/sprites-raw/<map>/')

  if (existsSync('data/sprites-raw')) pass('data/sprites-raw dir present')
  else warn('data/sprites-raw missing — needed before first `import-sprites <map>`')

  const fg = await getForegroundWindowTitle()
  if (fg && fg.toLowerCase().includes('maplestory')) pass(`Maplestory focused: ${fg}`)
  else warn(`Maplestory window not currently focused (optional). Foreground reads: "${fg ?? 'unknown'}"`)

  return ok ? 0 : 1
}
