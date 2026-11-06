import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  FILE_EDIT_MAX_BYTES,
  FileEditError,
} from './types.ts'
import type {
  ReadWorkspaceFileRequest,
  ReadWorkspaceFileResult,
  WriteWorkspaceFileRequest,
  WriteWorkspaceFileResult,
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
  readonly ctx?: { get?(name: string): unknown }
}

interface FsTarget {
  readonly key?: string
}

interface FsStat {
  readonly version?: string
  readonly bytes?: number
}

interface FileSystemLike {
  resolve(path: string, options?: { cwd?: string }): Promise<FsTarget>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  writeText(
    target: FsTarget,
    content: string,
    expected?: unknown,
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<{ readonly version?: string }>
  stat?(target: FsTarget, signal?: AbortSignal): Promise<FsStat>
}

interface SandboxPolicyLike {
  resolve(input: { session?: SessionLike }): unknown
}

function softGet<T extends object>(
  holder: { get?(name: string): unknown } | undefined,
  name: string,
  method: string,
): T | undefined {
  if (holder === undefined || typeof holder.get !== 'function') return undefined
  try {
    const value = holder.get(name)
    if (typeof value !== 'object' || value === null) return undefined
    if (typeof Reflect.get(value, method) !== 'function') return undefined
    return value as T
  } catch {
    return undefined
  }
}

function sessionCwd(session: SessionLike | undefined): string {
  const header = session?.header
  if (typeof header?.cwd === 'string' && header.cwd.trim() !== '') return header.cwd
  try {
    const requested = session?.requestHeader?.()
    if (typeof requested?.cwd === 'string' && requested.cwd.trim() !== '') return requested.cwd
  } catch {
    // ignore
  }
  throw new FileEditError('SESSION_CHANGED', 'Session workspace is unavailable')
}

function assertInsideWorkspace(workspaceRoot: string, absolutePath: string): void {
  const root = resolve(workspaceRoot)
  const target = resolve(absolutePath)
  const rel = relative(root, target)
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return
  throw new FileEditError('FILE_DENIED', 'Path is outside the session workspace')
}

function processPathOf(target: FsTarget, fallback: string): string {
  const key = typeof target.key === 'string' && target.key.trim() !== '' ? target.key : fallback
  return key
}

function mapFsError(error: unknown): never {
  const code = error !== null && typeof error === 'object'
    ? String(Reflect.get(error, 'code') ?? '')
    : ''
  const message = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'FS_NOT_FOUND':
      throw new FileEditError('FILE_NOT_FOUND', message || 'File not found')
    case 'FS_NOT_TEXT':
      throw new FileEditError('FILE_NOT_TEXT', message || 'File is not UTF-8 text')
    case 'FS_TOO_LARGE':
      throw new FileEditError('FILE_TOO_LARGE', message || 'File is too large to edit here')
    case 'FS_SANDBOX_DENIED':
    case 'FS_PERMISSION_DENIED':
      throw new FileEditError('FILE_DENIED', message || 'Permission denied')
    default:
      throw new FileEditError('FILE_EDIT_FAILED', message || 'File operation failed')
  }
}

function pickFs(agent: AgentLike | undefined, ctx: Context): FileSystemLike {
  const fromAgent = softGet<FileSystemLike>(agent?.ctx, 'fs', 'writeText')
  if (fromAgent !== undefined) return fromAgent
  const fromCtx = softGet<FileSystemLike>(ctx, 'fs', 'writeText')
  if (fromCtx !== undefined) return fromCtx
  // Hard inject on the host plugin still exposes ctx.fs.
  try {
    const direct = Reflect.get(ctx as object, 'fs') as FileSystemLike | undefined
    if (direct !== undefined && typeof direct.writeText === 'function') return direct
  } catch {
    // ignore
  }
  throw new FileEditError('FILE_EDIT_FAILED', 'Filesystem service is unavailable')
}

function pickPolicy(agent: AgentLike | undefined, ctx: Context): unknown {
  const sandbox = softGet<SandboxPolicyLike>(agent?.ctx, 'sandboxPolicy', 'resolve')
    ?? softGet<SandboxPolicyLike>(ctx, 'sandboxPolicy', 'resolve')
  if (sandbox === undefined) return undefined
  try {
    return sandbox.resolve({ session: agent?.session })
  } catch {
    return undefined
  }
}

async function resolveTarget(
  fs: FileSystemLike,
  workspaceRoot: string,
  path: string,
): Promise<{ readonly target: FsTarget, readonly absolutePath: string }> {
  const trimmed = path.trim()
  if (trimmed === '') throw new FileEditError('FILE_NOT_FOUND', 'Path is empty')
  const target = await fs.resolve(trimmed, { cwd: workspaceRoot })
  const absolutePath = processPathOf(target, isAbsolute(trimmed) ? trimmed : resolve(workspaceRoot, trimmed))
  assertInsideWorkspace(workspaceRoot, absolutePath)
  return { target, absolutePath }
}

export async function readWorkspaceFileNow(options: {
  readonly ctx: Context
  readonly request: ReadWorkspaceFileRequest
  readonly signal: AbortSignal
}): Promise<ReadWorkspaceFileResult> {
  options.signal.throwIfAborted()
  const agent = options.ctx.agents.get(options.request.sessionId) as AgentLike | undefined
  if (agent === undefined) {
    throw new FileEditError('SESSION_CHANGED', 'Session is not available')
  }
  const workspaceRoot = sessionCwd(agent.session)
  const fs = pickFs(agent, options.ctx)
  try {
    const { target, absolutePath } = await resolveTarget(fs, workspaceRoot, options.request.path)
    if (typeof fs.stat === 'function') {
      const info = await fs.stat(target, options.signal)
      if (typeof info.bytes === 'number' && info.bytes > FILE_EDIT_MAX_BYTES) {
        throw new FileEditError(
          'FILE_TOO_LARGE',
          `File exceeds the ${FILE_EDIT_MAX_BYTES} byte in-app edit limit`,
        )
      }
    }
    const text = await fs.readText(target, options.signal)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > FILE_EDIT_MAX_BYTES) {
      throw new FileEditError(
        'FILE_TOO_LARGE',
        `File exceeds the ${FILE_EDIT_MAX_BYTES} byte in-app edit limit`,
      )
    }
    return {
      path: options.request.path,
      absolutePath,
      text,
      bytes,
      truncated: false,
    }
  } catch (error) {
    if (error instanceof FileEditError) throw error
    if (options.signal.aborted) throw error
    mapFsError(error)
  }
}

export async function writeWorkspaceFileNow(options: {
  readonly ctx: Context
  readonly request: WriteWorkspaceFileRequest
  readonly signal: AbortSignal
}): Promise<WriteWorkspaceFileResult> {
  options.signal.throwIfAborted()
  const agent = options.ctx.agents.get(options.request.sessionId) as AgentLike | undefined
  if (agent === undefined) {
    throw new FileEditError('SESSION_CHANGED', 'Session is not available')
  }
  const content = options.request.content
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > FILE_EDIT_MAX_BYTES) {
    throw new FileEditError(
      'FILE_TOO_LARGE',
      `Content exceeds the ${FILE_EDIT_MAX_BYTES} byte in-app edit limit`,
    )
  }
  const workspaceRoot = sessionCwd(agent.session)
  const fs = pickFs(agent, options.ctx)
  const policy = pickPolicy(agent, options.ctx)
  try {
    const { target, absolutePath } = await resolveTarget(fs, workspaceRoot, options.request.path)
    // Skip replaceIfVersion: Desktop remotes have historically mangled mtimeNs in versions.
    await fs.writeText(target, content, undefined, options.signal, policy)
    return {
      path: options.request.path,
      absolutePath,
      bytes,
    }
  } catch (error) {
    if (error instanceof FileEditError) throw error
    if (options.signal.aborted) throw error
    mapFsError(error)
  }
}

export type { SessionId }
