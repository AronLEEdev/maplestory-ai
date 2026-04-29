import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '@/core/logger'
import {
  orchestrateSave,
  sampleColor,
  loadExistingCalibration,
  type SaveBody,
  type OrchestrateResult,
} from './orchestrate'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export interface ServerOpts {
  map: string
  screenshotPng: Buffer
  /** Called once orchestrateSave returns. Server exits soon after. */
  onSave: (result: OrchestrateResult) => void
  /** Called when user clicks Cancel. Server exits. */
  onCancel?: () => void
  /** Bind host. Default 127.0.0.1. */
  host?: string
  /** Bind port. 0 = random. Default random. */
  port?: number
}

export interface ServerHandle {
  url: string
  port: number
  close(): Promise<void>
}

/**
 * Start the calibration server. Returns the URL the user should open and a
 * close handle. The server keeps the captured PNG in memory and exposes:
 *   GET  /                   → wizard HTML
 *   GET  /screenshot.png     → the captured PNG
 *   GET  /static/<file>      → CSS / JS assets
 *   POST /sample-color       → returns RGB at a coord
 *   POST /save               → triggers orchestrateSave + invokes onSave
 *   POST /cancel             → invokes onCancel
 */
export async function startCalibrateServer(opts: ServerOpts): Promise<ServerHandle> {
  const fastify: FastifyInstance = Fastify({ logger: false })
  // public assets dir resolves relative to this compiled file's location.
  // tsx serves from src/, so we look for src/calibrate/public next to this file.
  const publicDir = resolvePublicDir()

  fastify.get('/', async (_req, reply) => {
    reply.type('text/html')
    return readFileSync(join(publicDir, 'index.html'))
  })

  fastify.get('/screenshot.png', async (_req, reply) => {
    reply.type('image/png')
    return opts.screenshotPng
  })

  fastify.get('/static/*', async (req, reply) => {
    const filename = (req.params as { '*': string })['*']
    const path = join(publicDir, filename)
    try {
      statSync(path)
    } catch {
      reply.code(404)
      return 'not found'
    }
    if (filename.endsWith('.js')) reply.type('application/javascript')
    else if (filename.endsWith('.css')) reply.type('text/css')
    else if (filename.endsWith('.png')) reply.type('image/png')
    return readFileSync(path)
  })

  fastify.get('/existing', async (_req, reply) => {
    const data = loadExistingCalibration('routines', opts.map)
    if (!data) {
      reply.code(404)
      return { ok: false }
    }
    return { ok: true, ...data }
  })

  fastify.post<{ Body: { x: number; y: number } }>('/sample-color', async (req) => {
    const rgb = await sampleColor(opts.screenshotPng, req.body)
    return { rgb }
  })

  fastify.post<{ Body: SaveBody }>('/save', async (req, reply) => {
    try {
      const result = await orchestrateSave({
        map: opts.map,
        screenshotPng: opts.screenshotPng,
        body: req.body,
      })
      // Defer onSave so the HTTP response goes out first.
      setImmediate(() => opts.onSave(result))
      return { ok: true, ...result }
    } catch (err) {
      logger.error({ err }, 'calibrate: save failed')
      reply.code(500)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  fastify.post('/cancel', async () => {
    setImmediate(() => opts.onCancel?.())
    return { ok: true }
  })

  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 0
  await fastify.listen({ host, port })
  const addr = fastify.server.address()
  if (!addr || typeof addr === 'string') {
    throw new Error('calibrate server: no address after listen')
  }
  const actualPort = addr.port
  const url = `http://${host}:${actualPort}`
  logger.info({ url, map: opts.map }, 'calibrate server up')

  return {
    url,
    port: actualPort,
    close: () => fastify.close(),
  }
}

/**
 * The compiled module sits at dist/calibrate/server.js (or runs via tsx from
 * src/calibrate/server.ts). Public assets live at src/calibrate/public/* —
 * we look for them relative to the source file. When run via tsx the dirname
 * is src/calibrate/, when run via tsc-built JS it's dist/calibrate/.
 */
function resolvePublicDir(): string {
  // src/calibrate/public when running via tsx
  const srcCandidate = join(__dirname, 'public')
  try {
    statSync(srcCandidate)
    return srcCandidate
  } catch {
    // dist build: copy public/ alongside the compiled JS, OR fall back to
    // the source path if a dev runs `node dist/...` from repo root.
    const repoRoot = process.cwd()
    return join(repoRoot, 'src', 'calibrate', 'public')
  }
}
