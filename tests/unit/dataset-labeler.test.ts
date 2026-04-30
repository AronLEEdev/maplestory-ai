import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { startLabelerServer, readFrameList } from '@/dataset/labeler'

let root: string
let datasetDir: string
let rawDir: string
let labelDir: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'lbl-'))
  datasetDir = join(root, 'henesys')
  rawDir = join(datasetDir, 'raw')
  labelDir = join(datasetDir, 'labels')
  mkdirSync(rawDir, { recursive: true })
  mkdirSync(labelDir, { recursive: true })
  // Two fake frames.
  for (const name of ['frame-a.png', 'frame-b.png']) {
    const buf = await sharp(Buffer.alloc(40 * 30 * 3, 80), {
      raw: { width: 40, height: 30, channels: 3 },
    })
      .png()
      .toBuffer()
    writeFileSync(join(rawDir, name), buf)
  }
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readFrameList', () => {
  it('lists raw frames with labelCount=-1 when no label file exists', () => {
    const list = readFrameList('henesys', datasetDir)
    expect(list.length).toBe(2)
    expect(list.map((f) => f.name).sort()).toEqual(['frame-a.png', 'frame-b.png'])
    for (const f of list) expect(f.labelCount).toBe(-1)
  })

  it('reports labelCount=0 for an explicit empty (hard-negative) label', () => {
    writeFileSync(join(labelDir, 'frame-a.txt'), '')
    const list = readFrameList('henesys', datasetDir)
    const a = list.find((f) => f.name === 'frame-a.png')!
    expect(a.labelCount).toBe(0)
  })

  it('reports the actual number of labels in the file', () => {
    writeFileSync(
      join(labelDir, 'frame-b.txt'),
      '0 0.5 0.5 0.3 0.4\n1 0.2 0.7 0.1 0.15\n',
    )
    const list = readFrameList('henesys', datasetDir)
    const b = list.find((f) => f.name === 'frame-b.png')!
    expect(b.labelCount).toBe(2)
  })
})

describe('labeler server routes', () => {
  it('GET /api/frames returns the dataset summary', async () => {
    const srv = await startLabelerServer({ map: 'henesys', port: 0, datasetDir })
    try {
      const resp = await fetch(`${srv.url}/api/frames`)
      const data = await resp.json()
      expect(data.classes).toEqual(['player', 'mob'])
      expect(data.frames.length).toBe(2)
    } finally {
      await srv.close()
    }
  })

  it('PUT /api/labels/:name validates and persists the YOLO body', async () => {
    const srv = await startLabelerServer({ map: 'henesys', port: 0, datasetDir })
    try {
      const ok = await fetch(`${srv.url}/api/labels/frame-a.png`, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: '0 0.5 0.5 0.3 0.4',
      })
      expect(ok.status).toBe(200)
      expect(existsSync(join(labelDir, 'frame-a.txt'))).toBe(true)
      expect(readFileSync(join(labelDir, 'frame-a.txt'), 'utf8')).toContain('0 0.5')

      // Bad body → 400, no write.
      const bad = await fetch(`${srv.url}/api/labels/frame-b.png`, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: 'garbage',
      })
      expect(bad.status).toBe(400)
      expect(existsSync(join(labelDir, 'frame-b.txt'))).toBe(false)
    } finally {
      await srv.close()
    }
  })

  it('DELETE /api/frame/:name removes both the image and any label', async () => {
    writeFileSync(join(labelDir, 'frame-a.txt'), '0 0.5 0.5 0.3 0.4')
    const srv = await startLabelerServer({ map: 'henesys', port: 0, datasetDir })
    try {
      const resp = await fetch(`${srv.url}/api/frame/frame-a.png`, { method: 'DELETE' })
      expect(resp.status).toBe(200)
      expect(existsSync(join(rawDir, 'frame-a.png'))).toBe(false)
      expect(existsSync(join(labelDir, 'frame-a.txt'))).toBe(false)
    } finally {
      await srv.close()
    }
  })

  it('blocks path traversal on the frame name', async () => {
    const srv = await startLabelerServer({ map: 'henesys', port: 0, datasetDir })
    try {
      const resp = await fetch(`${srv.url}/api/frame/${encodeURIComponent('../../etc/passwd')}`)
      expect([404, 400]).toContain(resp.status)
    } finally {
      await srv.close()
    }
  })
})
