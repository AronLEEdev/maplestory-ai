import { describe, it, expect } from 'vitest'
import { extractAndValidate } from '@/analyzer/post-process'

describe('extractAndValidate', () => {
  it('extracts JSON from fenced block and validates', () => {
    const llm =
      '```json\n{"game":"maplestory","resolution":[1920,1080],"window_title":"MapleStory","regions":{"hp":{"x":0,"y":0,"w":1,"h":1},"mp":{"x":0,"y":0,"w":1,"h":1},"minimap":{"x":0,"y":0,"w":1,"h":1}},"reflex":[],"perception":{"template_dir":"data/templates/x","fps":12,"match_threshold":0.75,"stride":2},"rotation":[],"movement":{"primitives":[],"loop":true,"pause_while_attacking":true}}\n```'
    const r = extractAndValidate(llm)
    expect(r.ok).toBe(true)
  })
  it('returns error on bad JSON', () => {
    const r = extractAndValidate('not json')
    expect(r.ok).toBe(false)
  })
})
