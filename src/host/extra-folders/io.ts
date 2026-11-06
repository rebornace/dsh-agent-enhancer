import { promises as fsp } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  assertInsideAllowedRoots,
  isInsideRoot,
  normalizeRootPath,
} from './paths.ts'
import { pickDirectoryNow } from './pick.ts'
import type { ExtraFoldersStore } from './store.ts'
import {
  EXTRA_FOLDERS_MAX_ROOTS,
  ExtraFoldersError,
  type AddExtraFolderRequest,
  type ExtraFolderEntry,
  type ExtraFolderRoot,
  type ListExtraFolderEntriesRequest,
  type ListExtraFolderEntriesResult,
  type ListExtraFoldersRequest,
  type ListExtraFoldersResult,
  type PickExtraFolderRequest,
  type PickExtraFolderResult,
  type RemoveExtraFolderRequest,
} from './types.ts'

interface SessionHeader {
  readonly cwd?: string
}

interface SessionLike {
  readonly header?: SessionHeader
  requestHeader?(): SessionHeader
}

interface AgentLike {
  readonly session?: SessionLike
}

function sessionCwd(session: SessionLike | undefined): string {
  const header = session?.header
  if (typeof header?.cwd === 'string' && header.cwd.trim() !== '') return resolve(header.cwd)
  try {
    const requested = session?.requestHeader?.()
    if (typeof requested?.cwd === 'string' && requested.cwd.trim() !== '') {
      return resolve(requested.cwd)
    }
  } catch {
    // ignore
  }
  throw new ExtraFoldersError('SESSION_CHANGED', 'Session workspace is unavailable')
}

function agentOf(ctx: Context, sessionId: SessionId): AgentLike {
  const agent = ctx.agents.get(sessionId) as AgentLike | undefined
  if (agent === undefined) {
    throw new ExtraFoldersError('SESSION_CHANGED', 'Session is not available')
  }
  return agent
}

function titleOf(path: string, explicit?: string): string {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const name = basename(path)
  return name === '' ? path : name
}

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase()
}

async function assertDirectory(absolutePath: string): Promise<void> {
  try {
    const stat = await fsp.stat(absolutePath)
    if (!stat.isDirectory()) {
      throw new ExtraFoldersError('FILE_DENIED', 'Path is not a directory')
    }
  } catch (error) {
    if (error instanceof ExtraFoldersError) throw error
    const code = error !== null && typeof error === 'object'
      ? String(Reflect.get(error, 'code') ?? '')
      : ''
    if (code === 'ENOENT') {
      throw new ExtraFoldersError('FILE_NOT_FOUND', 'Directory not found')
    }
    throw new ExtraFoldersError(
      'FILE_EDIT_FAILED',
      error instanceof Error ? error.message : 'Cannot access directory',
    )
  }
}

export async function listExtraFoldersNow(options: {
  readonly ctx: Context
  readonly store: ExtraFoldersStore
  readonly request: ListExtraFoldersRequest
  readonly signal: AbortSignal
}): Promise<ListExtraFoldersResult> {
  options.signal.throwIfAborted()
  const agent = agentOf(options.ctx, options.request.sessionId)
  const primaryCwd = sessionCwd(agent.session)
  const doc = options.store.load(primaryCwd)
  return {
    primaryCwd,
    primaryTitle: titleOf(primaryCwd),
    roots: doc.roots,
  }
}

async function attachRoot(options: {
  readonly store: ExtraFoldersStore
  readonly primaryCwd: string
  readonly absolute: string
  readonly title?: string
}): Promise<ListExtraFoldersResult> {
  const absolute = options.absolute
  await assertDirectory(absolute)
  if (samePath(absolute, options.primaryCwd) || isInsideRoot(options.primaryCwd, absolute)) {
    throw new ExtraFoldersError(
      'FILE_DENIED',
      'Folder is already inside the session workspace root',
    )
  }
  const doc = options.store.load(options.primaryCwd)
  if (doc.roots.some(root => samePath(root.path, absolute))) {
    throw new ExtraFoldersError('FILE_DENIED', 'Folder is already attached')
  }
  if (doc.roots.length >= EXTRA_FOLDERS_MAX_ROOTS) {
    throw new ExtraFoldersError(
      'FILE_DENIED',
      `At most ${EXTRA_FOLDERS_MAX_ROOTS} extra folders are allowed`,
    )
  }
  const next: ExtraFolderRoot[] = [
    ...doc.roots,
    { path: absolute, title: titleOf(absolute, options.title) },
  ]
  const saved = options.store.save(options.primaryCwd, next)
  return {
    primaryCwd: options.primaryCwd,
    primaryTitle: titleOf(options.primaryCwd),
    roots: saved.roots,
  }
}

export async function addExtraFolderNow(options: {
  readonly ctx: Context
  readonly store: ExtraFoldersStore
  readonly request: AddExtraFolderRequest
  readonly signal: AbortSignal
}): Promise<ListExtraFoldersResult> {
  options.signal.throwIfAborted()
  const agent = agentOf(options.ctx, options.request.sessionId)
  const primaryCwd = sessionCwd(agent.session)
  let absolute: string
  try {
    absolute = normalizeRootPath(options.request.path)
  } catch (error) {
    throw new ExtraFoldersError(
      'FILE_DENIED',
      error instanceof Error ? error.message : 'Invalid path',
    )
  }
  return attachRoot({
    store: options.store,
    primaryCwd,
    absolute,
    title: options.request.title,
  })
}

/** Open the OS folder dialog and attach the picked path when confirmed. */
export async function pickExtraFolderNow(options: {
  readonly ctx: Context
  readonly store: ExtraFoldersStore
  readonly request: PickExtraFolderRequest
  readonly signal: AbortSignal
}): Promise<PickExtraFolderResult> {
  options.signal.throwIfAborted()
  const agent = agentOf(options.ctx, options.request.sessionId)
  const primaryCwd = sessionCwd(agent.session)
  const current = options.store.load(primaryCwd)
  const picked = await pickDirectoryNow(options.signal)
  if (picked.path === null) {
    return {
      path: null,
      primaryCwd,
      primaryTitle: titleOf(primaryCwd),
      roots: current.roots,
      added: false,
    }
  }
  const absolute = normalizeRootPath(picked.path)
  const saved = await attachRoot({
    store: options.store,
    primaryCwd,
    absolute,
  })
  return {
    path: absolute,
    primaryCwd: saved.primaryCwd,
    primaryTitle: saved.primaryTitle,
    roots: saved.roots,
    added: true,
  }
}

export async function removeExtraFolderNow(options: {
  readonly ctx: Context
  readonly store: ExtraFoldersStore
  readonly request: RemoveExtraFolderRequest
  readonly signal: AbortSignal
}): Promise<ListExtraFoldersResult> {
  options.signal.throwIfAborted()
  const agent = agentOf(options.ctx, options.request.sessionId)
  const primaryCwd = sessionCwd(agent.session)
  let absolute: string
  try {
    absolute = normalizeRootPath(options.request.path)
  } catch (error) {
    throw new ExtraFoldersError(
      'FILE_DENIED',
      error instanceof Error ? error.message : 'Invalid path',
    )
  }
  const doc = options.store.load(primaryCwd)
  const next = doc.roots.filter(root => !samePath(root.path, absolute))
  if (next.length === doc.roots.length) {
    throw new ExtraFoldersError('FILE_NOT_FOUND', 'Attached folder not found')
  }
  const saved = options.store.save(primaryCwd, next)
  return {
    primaryCwd,
    primaryTitle: titleOf(primaryCwd),
    roots: saved.roots,
  }
}

function relativeUnderRoot(rootPath: string, relativePath: string | undefined): string {
  const raw = (relativePath ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (raw === '' || raw === '.') return ''
  const parts = raw.split('/').filter(part => part !== '' && part !== '.')
  if (parts.some(part => part === '..')) {
    throw new ExtraFoldersError('FILE_DENIED', 'Path escapes the folder root')
  }
  return parts.join(sep)
}

export async function listExtraFolderEntriesNow(options: {
  readonly ctx: Context
  readonly store: ExtraFoldersStore
  readonly request: ListExtraFolderEntriesRequest
  readonly signal: AbortSignal
}): Promise<ListExtraFolderEntriesResult> {
  options.signal.throwIfAborted()
  const agent = agentOf(options.ctx, options.request.sessionId)
  const primaryCwd = sessionCwd(agent.session)
  const doc = options.store.load(primaryCwd)
  const extraPaths = doc.roots.map(root => root.path)
  let rootPath: string
  try {
    rootPath = normalizeRootPath(options.request.rootPath)
  } catch (error) {
    throw new ExtraFoldersError(
      'FILE_DENIED',
      error instanceof Error ? error.message : 'Invalid root path',
    )
  }
  const allowed = samePath(rootPath, primaryCwd)
    || extraPaths.some(path => samePath(path, rootPath))
  if (!allowed) {
    throw new ExtraFoldersError('FILE_DENIED', 'Root is not the workspace or an attached folder')
  }
  const relativePath = relativeUnderRoot(rootPath, options.request.relativePath)
  const absoluteDir = relativePath === '' ? rootPath : join(rootPath, relativePath)
  assertInsideAllowedRoots(primaryCwd, extraPaths, absoluteDir)
  await assertDirectory(absoluteDir)

  let names: string[]
  try {
    names = await fsp.readdir(absoluteDir)
  } catch (error) {
    throw new ExtraFoldersError(
      'FILE_EDIT_FAILED',
      error instanceof Error ? error.message : 'Cannot list directory',
    )
  }

  const entries: ExtraFolderEntry[] = []
  for (const name of names) {
    if (name === '.' || name === '..') continue
    const absolutePath = join(absoluteDir, name)
    try {
      assertInsideAllowedRoots(primaryCwd, extraPaths, absolutePath)
      const stat = await fsp.lstat(absolutePath)
      if (stat.isSymbolicLink()) continue
      const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null
      if (kind === null) continue
      const path = relativePath === '' ? name : join(relativePath, name)
      entries.push({ name, path: path.replace(/\\/g, '/'), absolutePath, kind })
    } catch {
      // Skip unreadable / escaped entries.
    }
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  return {
    rootPath,
    relativePath: relativePath.replace(/\\/g, '/'),
    entries,
  }
}

/** Paths attached for a session's primary cwd (for file-edit fence). */
export function loadExtraRootPaths(
  store: ExtraFoldersStore,
  primaryCwd: string,
): readonly string[] {
  return store.load(resolve(primaryCwd)).roots.map(root => root.path)
}
