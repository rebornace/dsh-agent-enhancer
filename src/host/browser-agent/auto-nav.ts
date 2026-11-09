/**
 * Dead-click recovery helpers. Prefer name-matched same-origin links —
 * never hop to unrelated site chrome just because the path is "deeper".
 */

function pathKey(raw: string): string {
  try {
    const u = new URL(raw)
    const path = u.pathname.replace(/\/+$/u, '') || '/'
    return `${u.origin}${path}`
  } catch {
    return raw.split('?')[0]?.split('#')[0]?.replace(/\/+$/u, '') ?? raw
  }
}

export function pathsDiffer(a: string, b: string): boolean {
  return pathKey(a) !== pathKey(b)
}

function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/\s+/gu, ' ').trim()
}

/** True when link label and clicked control label clearly refer to the same thing. */
export function namesLooselyMatch(preferredName: string, linkName: string): boolean {
  const a = normalizeName(preferredName)
  const b = normalizeName(linkName)
  if (a.length < 2 || b.length < 2) return false
  if (a === b) return true
  if (a.includes(b) || b.includes(a)) return true
  // Shared substantive token (≥4 chars) — avoids matching bare "热门"/"首页" noise.
  const tokensA = new Set(a.split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 4))
  if (tokensA.size === 0) return false
  for (const token of b.split(/[^\p{L}\p{N}]+/u)) {
    if (token.length >= 4 && tokensA.has(token)) return true
  }
  return false
}

/**
 * Auto-navigate only when a recovered link's name matches the dead click.
 * Depth alone is unsafe (feeds often expose /v/popular/all etc. without content URLs).
 */
export function pickAutoNavigateHref(
  links: ReadonlyArray<{ readonly href: string; readonly name?: string }>,
  beforeUrl: string,
  preferredName = '',
): string | null {
  if (preferredName.trim() === '') return null
  let beforeOrigin = ''
  try {
    beforeOrigin = new URL(beforeUrl).origin
  } catch {
    beforeOrigin = ''
  }
  let best: string | null = null
  let bestDepth = -1
  for (const item of links) {
    if (!/^https?:\/\//i.test(item.href) || !pathsDiffer(beforeUrl, item.href)) continue
    if (!namesLooselyMatch(preferredName, item.name || item.href)) continue
    try {
      const u = new URL(item.href)
      if (beforeOrigin !== '' && u.origin !== beforeOrigin) continue
      const depth = u.pathname.split('/').filter(Boolean).length
      if (depth > bestDepth) {
        bestDepth = depth
        best = item.href
      }
    } catch {
      // ignore
    }
  }
  return best
}
