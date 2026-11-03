import { PACKAGE_NAME, PACKAGE_VERSION } from '../../identity.ts'

export interface FetchLatestVersionOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly currentVersion?: string
  readonly timeoutMs?: number
  /** Override registry probe order (tests). */
  readonly sources?: readonly RegistrySource[]
}

export type RegistrySource =
  | { readonly kind: 'npm-dist-tag'; readonly baseUrl: string }
  | { readonly kind: 'package-json'; readonly url: string }

function defaultSources(): readonly RegistrySource[] {
  return [
    { kind: 'npm-dist-tag', baseUrl: 'https://registry.npmjs.org' },
    // CDN package.json is reliable when the npm registry is unreachable.
    {
      kind: 'package-json',
      url: `https://cdn.jsdelivr.net/npm/${encodeURIComponent(PACKAGE_NAME)}/package.json`,
    },
    // Mainland mirror last — some packages publish a misleading `latest` tag there.
    { kind: 'npm-dist-tag', baseUrl: 'https://registry.npmmirror.com' },
  ]
}

/** Accept only plain x.y.z so mirrors cannot feed prerelease/`0.0.0-stage` noise. */
function isUsableReleaseVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value)
}

function abortSignal(timeoutMs: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(timeoutMs)
  } catch {
    return undefined
  }
}

function readDistTagLatest(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const distTags = (body as Record<string, unknown>)['dist-tags']
  if (distTags === null || typeof distTags !== 'object') return null
  const latest = (distTags as Record<string, unknown>).latest
  if (typeof latest !== 'string' || !isUsableReleaseVersion(latest)) return null
  return latest
}

function readPackageJsonVersion(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const version = (body as Record<string, unknown>).version
  if (typeof version !== 'string' || !isUsableReleaseVersion(version)) return null
  return version
}

async function fetchJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  currentVersion: string,
  timeoutMs: number,
): Promise<unknown | null> {
  try {
    const response = await fetchImpl(url, {
      signal: abortSignal(timeoutMs),
      headers: {
        Accept: 'application/json',
        'User-Agent': `dsh-agent-enhancer/${currentVersion}`,
      },
    })
    if (!response.ok) {
      console.error(`agent-enhancer update: registry ${url} returned ${response.status}`)
      return null
    }
    return await response.json()
  } catch (error) {
    console.error(`agent-enhancer update: registry fetch failed for ${url}`, error)
    return null
  }
}

export async function fetchLatestVersion(
  packageName: string,
  opts: FetchLatestVersionOptions = {},
): Promise<string | null> {
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const currentVersion = opts.currentVersion ?? PACKAGE_VERSION
  const timeoutMs = opts.timeoutMs ?? 12_000
  const sources = opts.sources ?? defaultSources()

  for (const source of sources) {
    switch (source.kind) {
      case 'npm-dist-tag': {
        const url = `${source.baseUrl.replace(/\/$/, '')}/${encodeURIComponent(packageName)}`
        const body = await fetchJson(fetchImpl, url, currentVersion, timeoutMs)
        const latest = readDistTagLatest(body)
        if (latest !== null) return latest
        break
      }
      case 'package-json': {
        const body = await fetchJson(fetchImpl, source.url, currentVersion, timeoutMs)
        const version = readPackageJsonVersion(body)
        if (version !== null) return version
        break
      }
      default: {
        const _exhaustive: never = source
        return _exhaustive
      }
    }
  }
  return null
}
