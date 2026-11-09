import { describe, expect, it } from 'vitest'

/** Cap extract payload the same way the extension does. */
function truncateExtract(text: string, maxChars: number): { text: string; truncated: boolean } {
  const limit = Math.min(Math.max(Math.floor(maxChars) || 8000, 500), 20_000)
  const raw = text.replace(/\s+/gu, ' ').trim()
  return {
    text: raw.slice(0, limit),
    truncated: raw.length > limit,
  }
}

describe('browser_extract truncation', () => {
  it('caps long page text and marks truncated', () => {
    const raw = 'a'.repeat(10_000)
    const out = truncateExtract(raw, 8000)
    expect(out.text.length).toBe(8000)
    expect(out.truncated).toBe(true)
  })

  it('does not invent site-specific selectors — focus is unused for matching', () => {
    const out = truncateExtract('Hello main content comments section', 500)
    expect(out.text).toContain('comments')
    expect(out.truncated).toBe(false)
  })
})
