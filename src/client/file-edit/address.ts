import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Matches `@deepseek-ai/dsh-util-workspace-path` file-address grammar
 * (inlined — not a Desktop seed). Peer: util/workspace-path `file-address`.
 */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

function encodePath(path: string): string {
  return path.split('/').map(encodeSegment).join('/')
}

function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\') || value.startsWith('//')
}

/** Absolute in Host spelling: POSIX `/…` or Windows drive / UNC. */
export function isAbsoluteWorkspacePath(path: string): boolean {
  return path.startsWith('/') || isWindowsStylePath(path)
}

function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`
}

/**
 * Absolute-scope address for paths outside a Session workspace.
 * Peer: `absoluteFileAddress` in `@deepseek-ai/dsh-util-workspace-path`.
 */
export function absoluteFileAddress(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const unc = normalized.startsWith('//')
  const absolute = normalized.replace(/^\/+/, '')
  return `${FILE_ADDRESS_PREFIX}absolute/${unc ? '/' : ''}${encodePath(absolute)}`
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

/**
 * Peer `fileAddressFor` (`@deepseek-ai/dsh-util-workspace-path`):
 * relative / in-workspace → session-relative; absolute outside workspace keeps
 * the absolute path inside a session address. Prefer `absoluteFileAddress` when
 * the Host must open a path with no Session workspace binding (Skills panel).
 */
export function fileAddressFor(
  sessionId: SessionId,
  cwd: string | undefined,
  path: string,
): string {
  const normalized = path.replace(/\\/g, '/')
  if (!isAbsoluteWorkspacePath(normalized)) {
    return sessionFileAddress(sessionId, normalized)
  }
  const root = cwd === undefined || cwd.trim() === ''
    ? ''
    : cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root !== '' && normalized === root) return sessionFileAddress(sessionId, '')
  if (root !== '' && normalized.startsWith(`${root}/`)) {
    return sessionFileAddress(sessionId, normalized.slice(root.length + 1))
  }
  return sessionFileAddress(sessionId, normalized)
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

/** Directory skill roots → `…/SKILL.md` for document preview. */
export function skillDocumentPath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  if (/\.md$/i.test(trimmed)) return trimmed
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  return `${trimmed}${sep}SKILL.md`
}
