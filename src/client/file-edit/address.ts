import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Matches `@deepseek-ai/dsh-util-workspace-path` file-address grammar (inlined — not a Desktop seed). */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

function encodePath(path: string): string {
  return path.split('/').map(encodeSegment).join('/')
}

function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`
}

function parseFileAddress(address: string): {
  readonly scope: 'session' | 'absolute'
  readonly sessionId?: string
  readonly path: string
} | undefined {
  try {
    if (!address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
    const end = address.search(/[?#]/)
    const [scope, ...rest] = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end).split('/')
    if (scope === 'session') {
      const [id, ...segments] = rest
      if (id === undefined || id === '' || segments.length === 0) return undefined
      return {
        scope,
        sessionId: decodeURIComponent(id),
        path: segments.map(decodeURIComponent).join('/'),
      }
    }
    if (scope === 'absolute') {
      const unc = rest[0] === '' && rest.length > 1
      const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent)
      if (segments.length === 0 || segments[0] === '') return undefined
      if (unc) return { scope, path: `//${segments.join('/')}` }
      const drive = segments[0] !== undefined && /^[A-Za-z]:$/.test(segments[0])
      return {
        scope,
        path: drive ? segments.join('/') : `/${segments.join('/')}`,
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

export function fileAddressOf(sessionId: SessionId, path: string): string {
  return sessionFileAddress(sessionId, path)
}

export function parseWorkspaceFileAddress(address: string | undefined): {
  readonly sessionId: SessionId
  readonly path: string
} | undefined {
  if (typeof address !== 'string' || address === '') return undefined
  const parsed = parseFileAddress(address)
  if (parsed === undefined || parsed.scope !== 'session') return undefined
  if (typeof parsed.sessionId !== 'string' || parsed.sessionId === '') return undefined
  if (typeof parsed.path !== 'string' || parsed.path === '') return undefined
  return {
    sessionId: parsed.sessionId as SessionId,
    path: parsed.path,
  }
}

export function basenameOfPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] || path
}
