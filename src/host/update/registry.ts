import { PACKAGE_VERSION } from '../../identity.ts'

export interface FetchLatestVersionOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly currentVersion?: string
  readonly timeoutMs?: number
}

const REGISTRY_BASE = 'https://registry.npmjs.org'

export async function fetchLatestVersion(
  packageName: string,
  opts: FetchLatestVersionOptions = {},
): Promise<string | null> {
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const currentVersion = opts.currentVersion ?? PACKAGE_VERSION
  const timeoutMs = opts.timeoutMs ?? 10_000
  const url = `${REGISTRY_BASE}/${encodeURIComponent(packageName)}`

  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': `dsh-agent-enhancer/${currentVersion}`,
      },
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (body === null || typeof body !== 'object') return null
    const distTags = (body as Record<string, unknown>)['dist-tags']
    if (distTags === null || typeof distTags !== 'object') return null
    const latest = (distTags as Record<string, unknown>).latest
    if (typeof latest !== 'string' || latest.length === 0) return null
    return latest
  } catch {
    return null
  }
}
