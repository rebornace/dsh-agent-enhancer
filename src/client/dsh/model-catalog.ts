import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'

type CatalogFn = () => Promise<RemoteResult<ModelCatalog>>

export interface ModelCatalogLoaders {
  readonly sessionModelCatalog?: CatalogFn
  readonly hostListCatalog?: CatalogFn
}

function asCatalogFn(face: unknown, method: string): CatalogFn | undefined {
  if (face === undefined || face === null || typeof face !== 'object') return undefined
  const fn = (face as Record<string, unknown>)[method]
  if (typeof fn !== 'function') return undefined
  return () => (fn as (this: unknown) => Promise<RemoteResult<ModelCatalog>>).call(face)
}

/**
 * Cordis remotes throw on nested faces that are not in `inject`
 * (`cannot get property "remote.session" without inject`). Probe softly.
 */
function probeRemoteFace(remote: object, name: string): unknown {
  try {
    return (remote as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}

/** Resolve catalog callables from a Client Remote face (soft property access). */
export function catalogLoadersFromRemote(remote: unknown): ModelCatalogLoaders {
  if (remote === undefined || remote === null || typeof remote !== 'object') return {}
  return {
    sessionModelCatalog: asCatalogFn(probeRemoteFace(remote, 'session'), 'modelCatalog'),
    hostListCatalog: asCatalogFn(probeRemoteFace(remote, 'composerEnhancer'), 'listCatalog'),
  }
}

/**
 * Load Desktop's live model catalog.
 * Prefer the official session selector catalog; fall back to this plugin's Host RPC.
 */
export async function loadDesktopModelCatalog(
  remoteOrLoaders: unknown | ModelCatalogLoaders,
): Promise<ModelCatalog> {
  const loaders: ModelCatalogLoaders = remoteOrLoaders !== null
    && typeof remoteOrLoaders === 'object'
    && ('sessionModelCatalog' in remoteOrLoaders || 'hostListCatalog' in remoteOrLoaders)
    ? remoteOrLoaders as ModelCatalogLoaders
    : catalogLoadersFromRemote(remoteOrLoaders)

  const attempts: Array<{ readonly name: string; readonly load: CatalogFn }> = []
  if (loaders.sessionModelCatalog) {
    attempts.push({ name: 'session.modelCatalog', load: loaders.sessionModelCatalog })
  }
  if (loaders.hostListCatalog) {
    attempts.push({ name: 'composerEnhancer.listCatalog', load: loaders.hostListCatalog })
  }
  if (attempts.length === 0) {
    throw new Error('no catalog RPC on remote (session/composerEnhancer missing)')
  }

  const errors: string[] = []
  for (const attempt of attempts) {
    try {
      const result = await attempt.load()
      if (result.ok) return result.value
      errors.push(`${attempt.name}: ${result.error.code}`)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      errors.push(`${attempt.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(errors.join(' | '))
}

export function modelOptionValue(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

export function parseModelOptionValue(value: string): { provider: string; model: string } | null {
  if (value === '') return null
  const separator = value.indexOf('\u0000')
  if (separator <= 0 || separator === value.length - 1) return null
  return {
    provider: value.slice(0, separator),
    model: value.slice(separator + 1),
  }
}

/**
 * Select/menu ids must be DOM-safe (no NUL): `follow` |
 * `m|provider|model` | `e|provider|model|effort`.
 * Provider/model ids from Desktop do not contain `|`.
 */
const SEP = '|'

export function encodeFollowSelection(): string {
  return 'follow'
}

export function encodeModelSelection(provider: string, model: string): string {
  return `m${SEP}${provider}${SEP}${model}`
}

export function encodeEffortSelection(provider: string, model: string, effort: string): string {
  return `e${SEP}${provider}${SEP}${model}${SEP}${effort}`
}

export type DecodedModelSelection =
  | { readonly kind: 'follow' }
  | { readonly kind: 'model'; readonly provider: string; readonly model: string; readonly reasoningEffort: string }

export function decodeModelSelection(id: string): DecodedModelSelection | null {
  if (id === 'follow') return { kind: 'follow' }
  if (id.startsWith(`m${SEP}`)) {
    const parts = id.slice(2).split(SEP)
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null
    return {
      kind: 'model',
      provider: parts[0]!,
      model: parts[1]!,
      reasoningEffort: '',
    }
  }
  if (id.startsWith(`e${SEP}`)) {
    const parts = id.slice(2).split(SEP)
    if (parts.length !== 3 || parts[0] === '' || parts[1] === '') return null
    return {
      kind: 'model',
      provider: parts[0]!,
      model: parts[1]!,
      reasoningEffort: parts[2]!,
    }
  }
  // Legacy NUL-separated ids from earlier builds.
  if (id.startsWith('m\u0000')) {
    const rest = id.slice(2)
    const separator = rest.indexOf('\u0000')
    if (separator <= 0 || separator === rest.length - 1) return null
    return {
      kind: 'model',
      provider: rest.slice(0, separator),
      model: rest.slice(separator + 1),
      reasoningEffort: '',
    }
  }
  if (id.startsWith('e\u0000')) {
    const parts = id.slice(2).split('\u0000')
    if (parts.length !== 3 || parts[0] === '' || parts[1] === '') return null
    return {
      kind: 'model',
      provider: parts[0]!,
      model: parts[1]!,
      reasoningEffort: parts[2]!,
    }
  }
  return null
}
