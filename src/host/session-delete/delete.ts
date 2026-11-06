import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionCleanupRegistry, SessionCleanerReport } from './cleanup.ts'

const SESSION_ID_RE = /^session-[0-9a-fA-F-]{36}$/
const SPILL_ROOT_RE = /^dsh-spill-[A-Za-z0-9_-]{6}$/

export interface DeleteSessionRequest {
  readonly sessionId: SessionId
}

export interface DeleteSessionResult {
  readonly ok: true
  readonly sessionId: SessionId
  readonly unloaded: boolean
  readonly hidden: boolean
  readonly live: boolean
  readonly removedPaths: readonly string[]
  readonly registry: {
    readonly workspaces: readonly string[]
    readonly archived: boolean
    readonly pinned: boolean
  }
  readonly pluginCleaners: readonly SessionCleanerReport[]
  readonly detail: string
}

export class SessionDeleteError extends Error {
  constructor(
    readonly code: 'INVALID_ID' | 'BUSY' | 'REGISTRY' | 'FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'SessionDeleteError'
  }
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function sessionsRoot(): string {
  return join(dshHome(), 'sessions')
}

function projcacheSessionsDir(): string {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions')
}

function spillBase(): string {
  return process.env.DSH_SESSION_DELETE_TMP ?? tmpdir()
}

function spillSessionDirName(sessionId: string): string {
  return `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`
}

function uuidOf(sessionId: string): string {
  return sessionId.slice('session-'.length)
}

function serviceOf(ctx: Context, key: string): unknown {
  try {
    return ctx.get(key as never)
  } catch {
    return undefined
  }
}

async function noteFailure(ctx: Context, message: string): Promise<void> {
  try {
    ctx.logger.warn(`agent-enhancer deleteSession: ${message}`)
  } catch {
    // ignore logger failures
  }
  try {
    const dir = join(dshHome(), 'profiles', 'desktop', 'plugin-data', 'dsh-agent-enhancer')
    await mkdir(dir, { recursive: true })
    await appendFile(
      join(dir, 'session-delete-last-error.log'),
      `${new Date().toISOString()} ${message}\n`,
      'utf8',
    )
  } catch {
    // Diagnostics must never block delete.
  }
}

function probeBusy(ctx: Context, sessionId: string): { busy: boolean, detail: string } {
  const agents = serviceOf(ctx, 'agents') as { get?: (id: string) => unknown } | undefined
  if (agents === undefined || typeof agents.get !== 'function') {
    return { busy: false, detail: 'agents-unavailable' }
  }
  let agent: unknown
  try {
    agent = agents.get(sessionId)
  } catch {
    agent = undefined
  }
  if (agent === undefined || agent === null) return { busy: false, detail: 'no-live-agent' }
  const face = agent as {
    status?: unknown
    session?: { getSnapshot?: () => { running?: boolean, pendingInteraction?: unknown } }
    getSnapshot?: () => { running?: boolean, pendingInteraction?: unknown }
  }
  if (face.status === 'running') return { busy: true, detail: 'running' }
  const snapshot = face.session?.getSnapshot?.() ?? face.getSnapshot?.()
  if (snapshot?.running === true) return { busy: true, detail: 'running' }
  if (snapshot?.pendingInteraction !== undefined && snapshot.pendingInteraction !== null) {
    return { busy: true, detail: 'pending-interaction' }
  }
  return { busy: false, detail: 'agent-idle' }
}

function isResident(ctx: Context, sessionId: string): boolean {
  const sessions = serviceOf(ctx, 'sessions') as { get?: (id: string) => unknown } | undefined
  if (sessions === undefined || typeof sessions.get !== 'function') return false
  try {
    return sessions.get(sessionId) !== undefined
  } catch {
    return false
  }
}

async function unloadLiveSession(
  ctx: Context,
  sessionId: string,
): Promise<{ unloaded: boolean, detail: string }> {
  const sessions = serviceOf(ctx, 'sessions') as {
    get?: (id: string) => unknown
    liveEntryFor?: (session: unknown) => { detach?: () => void } | unknown
    detachEntered?: (entry: unknown) => void
  } | undefined
  if (sessions === undefined || typeof sessions.get !== 'function') {
    return { unloaded: false, detail: 'sessions-unavailable' }
  }
  let session: unknown
  try {
    session = sessions.get(sessionId)
  } catch (error) {
    return { unloaded: false, detail: `get-failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (session === undefined || session === null) return { unloaded: false, detail: 'not-resident' }
  if (typeof sessions.liveEntryFor !== 'function') {
    return { unloaded: false, detail: 'no-liveEntryFor' }
  }
  try {
    const entry = sessions.liveEntryFor(session) as { detach?: () => void }
    if (entry === undefined || entry === null) return { unloaded: false, detail: 'no-entry' }
    if (typeof entry.detach === 'function') entry.detach()
    else if (typeof sessions.detachEntered === 'function') sessions.detachEntered(entry)
    else return { unloaded: false, detail: 'no-detach' }
  } catch (error) {
    return { unloaded: false, detail: `unload-failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  return isResident(ctx, sessionId)
    ? { unloaded: false, detail: 'still-resident' }
    : { unloaded: true, detail: 'detached' }
}

type WorkspaceEntity = {
  readonly id: string
  readonly title?: string
  readonly sessionIds: readonly string[]
  detachSession: (sessionId: string) => Promise<void>
}

type WorkspaceRegistryFace = {
  readonly archivedSessionIds: readonly string[]
  readonly pinnedSessionIds: readonly string[]
  list: () => readonly WorkspaceEntity[]
  archiveSession: (sessionId: string, options?: { stopActivity?: boolean }) => Promise<void>
  unarchiveSession: (sessionId: string) => Promise<void>
  unpinSession: (sessionId: string) => Promise<void>
}

function workspaceRegistryOf(ctx: Context): WorkspaceRegistryFace | undefined {
  const registry = serviceOf(ctx, 'workspaceRegistry') as Partial<WorkspaceRegistryFace> | undefined
  if (registry === undefined) return undefined
  if (typeof registry.list !== 'function') return undefined
  if (typeof registry.archiveSession !== 'function') return undefined
  if (typeof registry.unarchiveSession !== 'function') return undefined
  if (typeof registry.unpinSession !== 'function') return undefined
  return registry as WorkspaceRegistryFace
}

async function hideLiveRemnant(ctx: Context, sessionId: string): Promise<boolean> {
  const registry = workspaceRegistryOf(ctx)
  if (registry !== undefined) {
    if (registry.archivedSessionIds.includes(sessionId)) return false
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
      return true
    } catch (error) {
      await noteFailure(ctx, `hide via archiveSession failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  const facility = serviceOf(ctx, 'storageDomain') as {
    get?: (name: string) => {
      global?: { get: () => Record<string, unknown>, set: (value: Record<string, unknown>) => Promise<void> }
    } | undefined
  } | undefined
  const domain = facility?.get?.('workspace')
  if (domain?.global === undefined) return false
  try {
    const state = { ...domain.global.get() }
    const archived = Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds as string[] : []
    if (archived.includes(sessionId)) return false
    state.archivedSessionIds = [sessionId, ...archived]
    await domain.global.set(state)
    return true
  } catch (error) {
    await noteFailure(ctx, `hide via storageDomain failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

async function forgetInRegistry(
  ctx: Context,
  sessionId: string,
  options: { readonly keepArchiveHide: boolean },
): Promise<{ workspaces: string[], archived: boolean, pinned: boolean }> {
  const removed = { workspaces: [] as string[], archived: false, pinned: false }
  const registry = workspaceRegistryOf(ctx)
  if (registry !== undefined) {
    for (const workspace of registry.list()) {
      if (!workspace.sessionIds.includes(sessionId)) continue
      try {
        await workspace.detachSession(sessionId)
        removed.workspaces.push(workspace.title || workspace.id)
      } catch (error) {
        throw new SessionDeleteError(
          'REGISTRY',
          `detach from workspace failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (registry.pinnedSessionIds.includes(sessionId)) {
      try {
        await registry.unpinSession(sessionId)
        removed.pinned = true
      } catch (error) {
        throw new SessionDeleteError(
          'REGISTRY',
          `unpin failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (!options.keepArchiveHide && registry.archivedSessionIds.includes(sessionId)) {
      try {
        await registry.unarchiveSession(sessionId)
        removed.archived = true
      } catch (error) {
        throw new SessionDeleteError(
          'REGISTRY',
          `unarchive failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return removed
  }

  const facility = serviceOf(ctx, 'storageDomain') as {
    get?: (name: string) => {
      table?: (name: string) => {
        entries: () => Iterable<[string, { sessionIds?: string[], title?: string }]>
        update: (id: string, next: (current: unknown) => unknown) => Promise<void>
      }
      global?: {
        get: () => Record<string, unknown>
        set: (value: Record<string, unknown>) => Promise<void>
      }
    } | undefined
  } | undefined
  const domain = facility?.get?.('workspace')
  if (domain === undefined || typeof domain.table !== 'function' || domain.global === undefined) {
    throw new SessionDeleteError('REGISTRY', 'workspace registry is unavailable')
  }
  const globalState = { ...domain.global.get() }
  const archiveSet = Array.isArray(globalState.archivedSessionIds)
    ? globalState.archivedSessionIds as string[]
    : []
  const pinSet = Array.isArray(globalState.pinnedSessionIds)
    ? globalState.pinnedSessionIds as string[]
    : []
  let globalDirty = false
  if (!options.keepArchiveHide && archiveSet.includes(sessionId)) {
    removed.archived = true
    globalState.archivedSessionIds = archiveSet.filter(id => id !== sessionId)
    globalDirty = true
  }
  if (pinSet.includes(sessionId)) {
    removed.pinned = true
    globalState.pinnedSessionIds = pinSet.filter(id => id !== sessionId)
    globalDirty = true
  }
  if (globalDirty) await domain.global.set(globalState)

  const table = domain.table('workspaces')
  for (const [workspaceId, record] of table.entries()) {
    const owned = Array.isArray(record?.sessionIds) && record.sessionIds.includes(sessionId)
    if (!owned) continue
    await table.update(workspaceId, current => {
      const row = current as { sessionIds?: string[], title?: string }
      return {
        ...row,
        sessionIds: (row.sessionIds ?? []).filter(id => id !== sessionId),
        updatedAt: new Date().toISOString(),
      }
    })
    removed.workspaces.push(record.title || workspaceId)
  }
  return removed
}

async function removePathBestEffort(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true })
      return true
    } catch {
      if (attempt === 2) return false
      await new Promise(resolve => setTimeout(resolve, 120 * (attempt + 1)))
    }
  }
  return false
}

async function eraseSessionLog(sessionId: string): Promise<string[]> {
  const removed: string[] = []
  const root = sessionsRoot()
  if (!existsSync(root)) return removed
  for (const workspaceDir of await readdir(root)) {
    const target = join(root, workspaceDir, sessionId)
    if (!existsSync(target)) continue
    const normalizedRoot = root.toLowerCase()
    if (!target.toLowerCase().startsWith(normalizedRoot)) continue
    if (await removePathBestEffort(target)) removed.push(target)
  }
  return removed
}

async function eraseSpill(sessionId: string): Promise<string[]> {
  const removed: string[] = []
  let entries: string[]
  try {
    entries = await readdir(spillBase())
  } catch {
    return removed
  }
  const name = spillSessionDirName(sessionId)
  for (const entry of entries) {
    if (!SPILL_ROOT_RE.test(entry)) continue
    const target = join(spillBase(), entry, name)
    if (!existsSync(target)) continue
    if (await removePathBestEffort(target)) removed.push(target)
  }
  return removed
}

async function eraseProjcache(ctx: Context, sessionId: string): Promise<string[]> {
  const removed: string[] = []
  const uuid = uuidOf(sessionId)
  try {
    const facility = serviceOf(ctx, 'storageDomain') as {
      get?: (name: string) => {
        table?: (name: string) => { delete?: (key: string) => Promise<boolean> }
      } | undefined
    } | undefined
    const cacheDomain = facility?.get?.('session_projcache')
    if (cacheDomain && typeof cacheDomain.table === 'function') {
      const table = cacheDomain.table('sessions')
      if (table && typeof table.delete === 'function') {
        for (const key of new Set([sessionId, uuid])) {
          try {
            if (await table.delete(key)) removed.push(`session_projcache#sessions:${key}`)
          } catch {
            // continue
          }
        }
      }
    }
  } catch {
    // Fall through to file delete.
  }
  for (const cacheFile of [
    join(projcacheSessionsDir(), `${sessionId}.json`),
    join(projcacheSessionsDir(), `${uuid}.json`),
  ]) {
    if (!existsSync(cacheFile)) continue
    if (await removePathBestEffort(cacheFile)) removed.push(cacheFile)
  }
  return removed
}

function scheduleResidualPurge(ctx: Context, sessionId: string): void {
  const timer = setTimeout(() => {
    void eraseProjcache(ctx, sessionId).catch(() => undefined)
    void eraseSessionLog(sessionId).catch(() => undefined)
  }, 8000)
  timer.unref?.()
}

export async function deleteSessionNow(options: {
  readonly ctx: Context
  readonly request: DeleteSessionRequest
  readonly cleanup: SessionCleanupRegistry
  readonly signal: AbortSignal
}): Promise<DeleteSessionResult> {
  options.signal.throwIfAborted()
  const sessionId = options.request.sessionId
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new SessionDeleteError('INVALID_ID', 'session id is not a valid session-<uuid>')
  }

  const busy = probeBusy(options.ctx, sessionId)
  if (busy.busy) {
    throw new SessionDeleteError('BUSY', `session is busy (${busy.detail})`)
  }

  const wasResident = isResident(options.ctx, sessionId)
  let unloaded = false
  let hidden = false
  let unloadDetail = 'not-resident'
  if (wasResident) {
    const unload = await unloadLiveSession(options.ctx, sessionId)
    unloaded = unload.unloaded
    unloadDetail = unload.detail
    if (!unloaded) {
      hidden = await hideLiveRemnant(options.ctx, sessionId)
    }
  }

  options.signal.throwIfAborted()
  let registry: { workspaces: string[], archived: boolean, pinned: boolean }
  try {
    registry = await forgetInRegistry(options.ctx, sessionId, {
      keepArchiveHide: wasResident && !unloaded,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await noteFailure(options.ctx, `registry: ${message}`)
    if (error instanceof SessionDeleteError) throw error
    throw new SessionDeleteError('REGISTRY', message)
  }

  options.signal.throwIfAborted()
  const removedPaths = [
    ...(await eraseSessionLog(sessionId)),
    ...(await eraseProjcache(options.ctx, sessionId)),
    ...(await eraseSpill(sessionId)),
  ]

  if (wasResident && !unloaded) scheduleResidualPurge(options.ctx, sessionId)
  else if (removedPaths.length === 0) scheduleResidualPurge(options.ctx, sessionId)

  options.signal.throwIfAborted()
  const pluginCleaners = await options.cleanup.purgeAll(sessionId, options.signal)

  const live = isResident(options.ctx, sessionId)
  return {
    ok: true,
    sessionId,
    unloaded,
    hidden,
    live,
    removedPaths,
    registry,
    pluginCleaners,
    detail: unloaded
      ? 'detached'
      : hidden
        ? `hidden-remnant:${unloadDetail}`
        : unloadDetail,
  }
}
