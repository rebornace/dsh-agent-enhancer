// Re-export suite lives in auto-nav.test.ts
import { describe, expect, it } from 'vitest'
import { pickAutoNavigateHref } from './auto-nav.ts'

describe('pickAutoNavigateHref compat', () => {
  it('returns null without a preferred name (no blind chrome hop)', () => {
    const picked = pickAutoNavigateHref(
      [
        { href: 'https://example.com/' },
        { href: 'https://example.com/posts/42' },
      ],
      'https://example.com/',
    )
    expect(picked).toBeNull()
  })
})
