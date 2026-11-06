import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MONACO_ROUTE } from '../../shared/monaco-route.ts'

export { MONACO_ROUTE }

/** Path relative to vendor/monaco/vs — optional leading `vs/`. */
const FILE_PATTERN = /^(?:vs\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/

function packageRootCandidates(): readonly string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  // lib/index.js → ../vendor ; src/host/file-edit → ../../../vendor
  return [
    resolve(here, '..', 'vendor', 'monaco', 'vs'),
    resolve(here, '..', '..', 'vendor', 'monaco', 'vs'),
    resolve(here, '..', '..', '..', 'vendor', 'monaco', 'vs'),
  ]
}

export function resolveMonacoVsDir(): string {
  for (const candidate of packageRootCandidates()) {
    if (existsSync(join(candidate, 'loader.js'))) return candidate
  }
  return packageRootCandidates()[0]!
}

/** Normalize `vs/editor/...` and `editor/...` to a path under the vs directory. */
export function normalizeMonacoVsRelative(file: string): string {
  return file.startsWith('vs/') ? file.slice(3) : file
}

export function monacoFileError(file: string | null): string | null {
  if (file === null || file.length === 0) return 'missing file'
  if (file.includes('\0') || file.includes('\\') || file.includes('?') || file.includes('#')) {
    return 'invalid file'
  }
  if (file.startsWith('/') || /^[A-Za-z]:/.test(file)) return 'invalid file'
  if (!FILE_PATTERN.test(file)) return 'invalid file'
  const relative = normalizeMonacoVsRelative(file)
  if (relative === '' || relative.split('/').some(part => part === '' || part === '.' || part === '..')) {
    return 'invalid file'
  }
  return null
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.ttf':
      return 'font/ttf'
    case '.json':
      return 'application/json; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  })
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root)
  const normalized = resolve(candidate)
  if (normalized === normalizedRoot) return true
  return normalized.startsWith(normalizedRoot + sep)
}

async function locateFile(
  vsDir: string,
  relativeUnderVs: string,
): Promise<{ readonly path: string } | null> {
  const rootReal = await fsp.realpath(vsDir)
  const parts = relativeUnderVs.split('/')
  let cursor = rootReal
  for (const part of parts) {
    cursor = join(cursor, part)
    if (!isInside(rootReal, cursor)) return null
  }
  if (!isInside(rootReal, cursor)) return null
  try {
    const real = await fsp.realpath(cursor)
    if (!isInside(rootReal, real)) return null
    const stat = await fsp.stat(real)
    if (!stat.isFile()) return null
    return { path: real }
  } catch {
    return null
  }
}

export async function handleMonacoRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const requested = url.searchParams.get('file')
  const reason = monacoFileError(requested)
  if (reason !== null || requested === null) return plain(400, reason ?? 'missing file')

  // Serve from vendor/monaco/vs — drop optional `vs/` prefix from the query.
  let relative = normalizeMonacoVsRelative(requested)
  const vsDir = resolveMonacoVsDir()
  let located = await locateFile(vsDir, relative)
  if (located === null && !relative.endsWith('.js')) {
    const withJs = `${relative}.js`
    if (monacoFileError(withJs) === null) {
      located = await locateFile(vsDir, withJs)
      if (located !== null) relative = withJs
    }
  }
  if (located === null) return plain(404, 'not found')

  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'content-type': contentTypeFor(relative),
        'x-content-type-options': 'nosniff',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    })
  }

  const body = await fsp.readFile(located.path)
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentTypeFor(relative),
      'x-content-type-options': 'nosniff',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
}

type MonacoConnection = {
  readonly fetch?: {
    register?(options: {
      readonly path: string
      readonly methods: readonly string[]
      readonly requestBody: string
      readonly fetch: (request: Request) => Promise<Response>
    }): unknown
  }
}

/**
 * Soft-resolve `connection` only. Never read `ctx.connection` — Cordis throws on
 * undeclared inject property access and would kill the whole Host fiber (settings
 * then report "Plugin entry is no longer configurable").
 */
export function installMonacoRoute(ctx: {
  get?(name: string): unknown
  readonly logger: { warn(message: string): void }
}): void {
  let connection: MonacoConnection | undefined
  if (typeof ctx.get === 'function') {
    try {
      const value = ctx.get('connection')
      if (value !== null && typeof value === 'object') {
        connection = value as MonacoConnection
      }
    } catch {
      connection = undefined
    }
  }
  const register = connection?.fetch?.register
  if (typeof register !== 'function' || connection?.fetch === undefined) {
    ctx.logger.warn('agent-enhancer: Monaco route skipped (connection.fetch unavailable)')
    return
  }
  try {
    register.call(connection.fetch, {
      path: MONACO_ROUTE,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: request => handleMonacoRequest(request),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`agent-enhancer: Monaco route registration failed: ${detail}`)
  }
}
