import { describe, expect, it } from 'vitest'

/** Mirror of tools/extension pathKey — keep in sync when changing click success rules. */
function pathKey(raw: string): string {
  try {
    const u = new URL(raw)
    const path = u.pathname.replace(/\/+$/u, '') || '/'
    return `${u.origin}${path}`
  } catch {
    return raw.split('?')[0]?.split('#')[0]?.replace(/\/+$/u, '') ?? raw
  }
}

describe('browser click pathKey', () => {
  it('ignores tracking query churn on the same pathname', () => {
    const home = 'https://example.com/'
    const withQuery = 'https://example.com/?utm_source=x&spm=1'
    expect(pathKey(home)).toBe(pathKey(withQuery))
  })

  it('treats a different pathname as real navigation', () => {
    expect(pathKey('https://example.com/')).not.toBe(
      pathKey('https://example.com/posts/123'),
    )
  })
})
