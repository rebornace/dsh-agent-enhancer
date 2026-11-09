/**
 * Universal page-link harvest from HTML (SSR or live source).
 * Not site-specific: any absolute http(s) or root-relative href.
 */

export interface PageLink {
  readonly href: string
  readonly name: string
}

function normalizeHref(raw: string, baseUrl: string): string | null {
  try {
    const href = new URL(raw.startsWith('//') ? `https:${raw}` : raw, baseUrl).href
    if (!/^https?:\/\//i.test(href)) return null
    const u = new URL(href)
    u.hash = ''
    return u.href
  } catch {
    return null
  }
}

/** Extract navigable http(s) links from HTML. Prefer same-origin deeper paths. */
export function extractPageLinksFromHtml(html: string, pageUrl: string): PageLink[] {
  const out: PageLink[] = []
  const seen = new Set<string>()
  let origin = ''
  try {
    origin = new URL(pageUrl).origin
  } catch {
    origin = ''
  }
  const push = (raw: string, name = '') => {
    const href = normalizeHref(raw, pageUrl)
    if (href === null || seen.has(href)) return
    // Skip pure same-path homepage noise when we already have deeper links later.
    seen.add(href)
    out.push({ href, name: (name || href).slice(0, 100) })
  }

  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const raw = match[1] || ''
    if (raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:')) continue
    push(raw)
  }

  // Many SPAs embed content URLs in JSON/config without href= — harvest same-origin http(s) quotes.
  for (const match of html.matchAll(/["'](https?:\/\/[^"'\\]+)["']/gi)) {
    push(match[1] || '')
  }
  for (const match of html.matchAll(/["'](\/[^"'\\]{2,})["']/g)) {
    const raw = match[1] || ''
    if (raw.startsWith('//') || raw.startsWith('/{') || raw.includes('{')) continue
    push(raw)
  }

  // Prefer same-origin links whose path is deeper than "/" (likely content).
  out.sort((a, b) => {
    const score = (href: string) => {
      try {
        const u = new URL(href)
        if (origin && u.origin === origin) {
          const depth = u.pathname.split('/').filter(Boolean).length
          return depth >= 2 ? 0 : depth >= 1 ? 1 : 3
        }
        return 2
      } catch {
        return 4
      }
    }
    return score(a.href) - score(b.href)
  })
  return out.slice(0, 30)
}

export async function fetchPageLinks(
  pageUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PageLink[]> {
  if (!/^https?:\/\//i.test(pageUrl)) return []
  try {
    const res = await fetchImpl(pageUrl, {
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; dsh-agent-enhancer-browser/0.2.12)',
      },
    })
    if (!res.ok) return []
    const html = await res.text()
    return extractPageLinksFromHtml(html, pageUrl)
  } catch {
    return []
  }
}
