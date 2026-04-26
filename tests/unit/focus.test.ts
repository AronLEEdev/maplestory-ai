import { describe, it, expect } from 'vitest'
import { matchesPattern } from '@/core/focus'

describe('matchesPattern', () => {
  it('matches case-insensitive substring', () => {
    expect(matchesPattern('MapleStory v.245', 'maplestory')).toBe(true)
    expect(matchesPattern('chrome.exe', 'maplestory')).toBe(false)
  })
  it('returns false on null window title', () => {
    expect(matchesPattern(null, 'maplestory')).toBe(false)
  })
})
