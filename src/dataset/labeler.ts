import Fastify, { type FastifyInstance } from 'fastify'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, basename, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { logger } from '@/core/logger'
import { parseYolo, CLASS_NAMES } from './yolo-format'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export interface LabelerOpts {
  map: string
  /** Bind host. Default 127.0.0.1. */
  host?: string
  /** Bind port. 0 = random. Default random. */
  port?: number
  /** Override dataset root. Default: data/dataset/<map>/ */
  datasetDir?: string
}

export interface LabelerHandle {
  url: string
  port: number
  close(): Promise<void>
}

export interface FrameSummary {
  name: string
  /** Number of label boxes saved for this frame. -1 means no label file at all. */
  labelCount: number
  /** Path the frame image is served at. */
  imageUrl: string
}

/**
 * Start the labeler server. Reads frames from data/dataset/<map>/raw/ and
 * stores YOLO-format labels at data/dataset/<map>/labels/<name>.txt.
 *
 *   GET  /                                → labeler HTML
 *   GET  /static/<file>                   → CSS / JS assets
 *   GET  /api/frames                      → list of frames + label counts
 *   GET  /api/frame/:name                 → image bytes
 *   GET  /api/labels/:name                → YOLO txt (404 if no label file)
 *   PUT  /api/labels/:name                → write YOLO txt (body = text)
 *   DELETE /api/frame/:name               → remove image + label file
 *   POST /api/labels/:name/empty          → save explicit empty label (hard negative)
 */
export async function startLabelerServer(opts: LabelerOpts): Promise<LabelerHandle> {
  const fastify: FastifyInstance = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 })
  const publicDir = resolvePublicDir()
  const datasetDir = opts.datasetDir ?? join('data', 'dataset', opts.map)
  const rawDir = join(datasetDir, 'raw')
  const labelDir = join(datasetDir, 'labels')
  mkdirSync(rawDir, { recursive: true })
  mkdirSync(labelDir, { recursive: true })

  // Tell fastify to accept raw text bodies for the label PUT.
  fastify.addContentTypeParser(
    'text/plain',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  )

  fastify.get('/', async (_req, reply) => {
    reply.type('text/html')
    return readFileSync(join(publicDir, 'labeler.html'))
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
    return readFileSync(path)
  })

  fastify.get('/api/frames', async () => {
    const frames = listFrames(rawDir, labelDir)
    return { map: opts.map, classes: CLASS_NAMES, frames }
  })

  fastify.get<{ Params: { name: string } }>('/api/frame/:name', async (req, reply) => {
    const name = sanitizeName(req.params.name)
    const path = join(rawDir, name)
    if (!isPathInside(rawDir, path) || !existsSync(path)) {
      reply.code(404)
      return 'not found'
    }
    reply.type('image/png')
    return readFileSync(path)
  })

  fastify.get<{ Params: { name: string } }>('/api/labels/:name', async (req, reply) => {
    const name = sanitizeName(req.params.name)
    const path = join(labelDir, labelFileFor(name))
    if (!isPathInside(labelDir, path) || !existsSync(path)) {
      reply.code(404)
      return ''
    }
    reply.type('text/plain')
    return readFileSync(path)
  })

  fastify.put<{ Params: { name: string }; Body: string }>(
    '/api/labels/:name',
    async (req, reply) => {
      const name = sanitizeName(req.params.name)
      if (!existsSync(join(rawDir, name))) {
        reply.code(404)
        return { ok: false, error: 'frame does not exist' }
      }
      const body = typeof req.body === 'string' ? req.body : ''
      try {
        // Validate before writing — bad bodies should not silently corrupt
        // the dataset.
        parseYolo(body)
      } catch (err) {
        reply.code(400)
        return { ok: false, error: String((err as Error).message) }
      }
      const path = join(labelDir, labelFileFor(name))
      writeFileSync(path, body)
      return { ok: true }
    },
  )

  fastify.delete<{ Params: { name: string } }>('/api/frame/:name', async (req, reply) => {
    const name = sanitizeName(req.params.name)
    const framePath = join(rawDir, name)
    const labelPath = join(labelDir, labelFileFor(name))
    if (!isPathInside(rawDir, framePath) || !existsSync(framePath)) {
      reply.code(404)
      return { ok: false }
    }
    try {
      unlinkSync(framePath)
    } catch (err) {
      logger.warn({ err, framePath }, 'labeler: frame unlink failed')
    }
    if (existsSync(labelPath)) {
      try {
        unlinkSync(labelPath)
      } catch (err) {
        logger.warn({ err, labelPath }, 'labeler: label unlink failed')
      }
    }
    return { ok: true }
  })

  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 0
  await fastify.listen({ host, port })
  const addr = fastify.server.address()
  if (!addr || typeof addr === 'string') throw new Error('labeler: no address after listen')
  const url = `http://${host}:${addr.port}`
  logger.info({ url, map: opts.map, datasetDir }, 'labeler server up')
  return { url, port: addr.port, close: () => fastify.close() }
}

function listFrames(rawDir: string, labelDir: string): FrameSummary[] {
  if (!existsSync(rawDir)) return []
  const files = readdirSync(rawDir)
    .filter((f) => f.endsWith('.png'))
    .sort() // timestamp-prefixed names sort chronologically
  return files.map((name) => {
    const labelPath = join(labelDir, labelFileFor(name))
    let labelCount = -1
    if (existsSync(labelPath)) {
      try {
        const text = readFileSync(labelPath, 'utf8')
        labelCount = parseYolo(text).length
      } catch {
        labelCount = 0
      }
    }
    return {
      name,
      labelCount,
      imageUrl: `/api/frame/${encodeURIComponent(name)}`,
    }
  })
}

function labelFileFor(frameName: string): string {
  return frameName.replace(/\.png$/i, '.txt')
}

/** Block path traversal and untrusted slashes. */
function sanitizeName(s: string): string {
  return basename(s)
}
function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

function resolvePublicDir(): string {
  const srcCandidate = join(__dirname, 'public')
  try {
    statSync(srcCandidate)
    return srcCandidate
  } catch {
    return join(process.cwd(), 'src', 'dataset', 'public')
  }
}

/** Used by tests + headless callers. */
export function readFrameList(map: string, datasetDir?: string): FrameSummary[] {
  const root = datasetDir ?? join('data', 'dataset', map)
  return listFrames(join(root, 'raw'), join(root, 'labels'))
}

/** Read frame dimensions (canvas needs them to render correctly). */
export async function frameDims(framePath: string): Promise<{ w: number; h: number }> {
  const m = await sharp(framePath).metadata()
  return { w: m.width ?? 0, h: m.height ?? 0 }
}
