import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt'
import { extractAndValidate } from './post-process'
import type { Routine } from '@/routine/schema'

export interface AnalyzeOpts {
  recordingDir: string
  outRoutinePath: string
  apiKey: string
  model?: string
  framesEvery?: number
  maxRetries?: number
}

export async function analyze(opts: AnalyzeOpts): Promise<Routine> {
  const meta = JSON.parse(readFileSync(join(opts.recordingDir, 'meta.json'), 'utf8'))
  const inputs = readFileSync(join(opts.recordingDir, 'inputs.jsonl'), 'utf8')
  const vitals = readFileSync(join(opts.recordingDir, 'vitals.jsonl'), 'utf8')
  const frameNames = readdirSync(join(opts.recordingDir, 'frames')).sort()
  const every = opts.framesEvery ?? Math.max(1, Math.floor(frameNames.length / 40))
  const sampled = frameNames.filter((_, i) => i % every === 0)

  const images = sampled.slice(0, 20).map((name) => {
    const data = readFileSync(join(opts.recordingDir, 'frames', name))
    return {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: data.toString('base64'),
      },
    }
  })

  const client = new Anthropic({ apiKey: opts.apiKey })
  const userText = buildUserPrompt({
    framesSampled: sampled.length,
    resolution: meta.resolution,
    windowTitle: meta.windowTitle,
    inputsJsonl: inputs,
    vitalsJsonl: vitals,
  })

  let lastError = ''
  for (let attempt = 0; attempt <= (opts.maxRetries ?? 2); attempt++) {
    const messageContent = [
      ...images,
      {
        type: 'text' as const,
        text:
          attempt === 0
            ? userText
            : `${userText}\n\nPREVIOUS ATTEMPT FAILED VALIDATION:\n${lastError}\nFix the JSON to match the schema exactly.`,
      },
    ]
    const resp = await client.messages.create({
      model: opts.model ?? 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: messageContent }],
    })
    const text = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n')
    const r = extractAndValidate(text)
    if (r.ok) {
      const obj = { unreviewed: true, ...r.routine, recorded_from: opts.recordingDir }
      writeFileSync(opts.outRoutinePath, YAML.stringify(obj))
      return r.routine
    }
    lastError = r.error
  }
  throw new Error(`analyze: validation failed after retries: ${lastError}`)
}
