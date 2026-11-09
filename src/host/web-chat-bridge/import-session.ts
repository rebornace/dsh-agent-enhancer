/**
 * Desktop work-session seam (2026-11-09 review):
 *
 * Do not use fiber-scoped `SessionStore.create`. That session is removed when the
 * calling fiber unloads, and the log writer is attached by the Agent lifecycle
 * (`dsh-session` `SessionStore` docs). Official blank create is
 * `SessionCommandController.create` → `agents.createSession({ cwd, reusable })`
 * then `workspace.attachSession` (`dsh-api-session-controller` `commands.js`).
 * History-bearing create is `ctx.agents.create({ sessionId, seed, meta: { cwd } })`
 * (same factory as fork, without `isSeeded` — an import is replay history, not a
 * fork cut, so the constructor must not inject fork closers).
 *
 * `ctx.agents` on Desktop is `AgentRegistry` (`create`, not `createSession`).
 * `createSession` lives on `ApiSessionAgentController`, which is not a context
 * service. This import calls `createSession` when the caller supplies it, then
 * appends on `agent.session`. Otherwise it publishes the transcript as the seed
 * of `agents.create`. Either way the log is the Agent-owned session.
 *
 * `sessions.flush === false` means no durability listener ran; that is a failure.
 * After the transcript is written, every open turn is closed with
 * `reason: { kind: 'completed' }` so a trailing user message is not a live prompt.
 *
 * Provenance is prepended on the first user turn (not `developer/message`).
 * Text-only `user/message` + `assistant/message`; no synthetic tool results.
 *
 * v4 surface invariant: the first surface node must be a `system/message`
 * appended while the surface was empty (protected head). Without it, the
 * next live system-prompt projection fails with
 * `system/message requires a protected first surface head`. Import therefore
 * seeds an inert empty `createSystemMessage('')` head before any user/assistant
 * surface (same workaround as deepseek-harness #10619).
 */
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  SessionSeq,
  type Session,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import type { AuxiliaryErrorCode } from '../../errors.ts'
import { pickDirectoryNow } from '../extra-folders/pick.ts'
import { WEB_CHAT_MAX_MESSAGES, WEB_CHAT_MAX_TEXT_BYTES } from './limits.ts'
import type { WebChatTranscript } from './types.ts'

/**
 * Stable web-chat import error codes. Client should read `webChatCode` on
 * `agent-enhancer/failed` RemoteError details; when absent, parse the message
 * prefix `^(no-workspace|invalid-transcript|import-failed):`.
 */
export type WebChatImportErrorCode = 'no-workspace' | 'invalid-transcript' | 'import-failed'

export class WebChatImportError extends Error {
  constructor(
    readonly code: WebChatImportErrorCode,
    message: string,
    readonly sessionId?: SessionId,
  ) {
    super(message)
    this.name = 'WebChatImportError'
  }
}

/** Wire shape on `agent-enhancer/failed` when a web-chat RPC rejects. */
export interface WebChatImportRemoteErrorDetails {
  readonly code: AuxiliaryErrorCode
  readonly webChatCode: WebChatImportErrorCode
  readonly sessionId?: SessionId
}

export function webChatImportToRemoteError(error: unknown): RemoteError {
  if (error instanceof WebChatImportError) {
    const details: WebChatImportRemoteErrorDetails = {
      code: 'FILE_EDIT_FAILED',
      webChatCode: error.code,
      ...(error.sessionId === undefined ? {} : { sessionId: error.sessionId }),
    }
    return new RemoteError('agent-enhancer/failed', `${error.code}: ${error.message}`, details)
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new RemoteError('agent-enhancer/failed', detail || 'Web chat import failed', {
    code: 'FILE_EDIT_FAILED',
    webChatCode: 'import-failed',
  })
}

export interface WebChatWorkspaceRow {
  readonly id: string
  readonly title: string
  readonly cwd: string
}

/** Live Agent session the import writes or flushes. */
export interface WebChatAgentSession {
  readonly id: SessionId
  readonly session: Session
}

/** Handle returned by `AgentRegistry.create`. `dispose` tears down that agent and its session. */
export interface WebChatAgentHandle {
  readonly agent: WebChatAgentSession
  dispose(): Promise<void>
}

/**
 * `ApiSessionAgentController.createSession` request.
 * `reusable` is always false here so an import never reuses a blank session.
 */
export interface WebChatCreateSessionRequest {
  readonly cwd: string
  readonly reusable: (sessionId: SessionId) => boolean
  readonly sessionId?: SessionId
}

/** Default model route forwarded to `agents.create`, matching `createAgent`'s live accessors. */
export interface WebChatAgentOptions {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/**
 * Desktop agent owner. `createSession` is the blank-session controller seam.
 * `create` is `ctx.agents.create` (AgentRegistry), used with a transcript seed.
 */
export interface WebChatWorkAgents {
  createSession?(request: WebChatCreateSessionRequest): Promise<{
    readonly agent: WebChatAgentSession
    dispose?: () => Promise<void>
  }>
  create?(options: {
    readonly sessionId: SessionId
    readonly seed: readonly SessionEvent[]
    readonly meta: { readonly cwd: string }
    readonly agentOptions?: WebChatAgentOptions
  }): Promise<WebChatAgentHandle>
}

export interface ImportWebChatHistoryNowInput {
  readonly sessions: { flush(session: Session): Promise<boolean> }
  readonly agents: WebChatWorkAgents
  readonly agentOptions?: WebChatAgentOptions
  readonly workspaceId: string
  readonly cwd: string
  readonly transcript: WebChatTranscript
  readonly attachToWorkspace?: (sessionId: SessionId) => Promise<void>
}

export interface ImportWebChatHistoryNowResult {
  readonly sessionId: SessionId
}

export interface ImportWebChatHistoryRequest {
  readonly workspaceId: string
  readonly transcript: WebChatTranscript
}

function serviceOf(ctx: Context, key: string): unknown {
  try {
    return ctx.get(key as never)
  } catch {
    return undefined
  }
}

function assertTranscript(transcript: WebChatTranscript): void {
  if (transcript.turns.length === 0) {
    throw new WebChatImportError('invalid-transcript', 'Transcript has no turns')
  }
  if (transcript.turns.length > WEB_CHAT_MAX_MESSAGES) {
    throw new WebChatImportError(
      'invalid-transcript',
      `Exceeds message limit (${WEB_CHAT_MAX_MESSAGES})`,
    )
  }
  let bytes = 0
  for (const turn of transcript.turns) {
    bytes += Buffer.byteLength(turn.text, 'utf8')
    if (bytes > WEB_CHAT_MAX_TEXT_BYTES) {
      throw new WebChatImportError(
        'invalid-transcript',
        `Exceeds text byte limit (${WEB_CHAT_MAX_TEXT_BYTES})`,
      )
    }
  }
}

function importProvenancePrefix(transcript: WebChatTranscript): string {
  const partial = transcript.partial ? 'yes' : 'no'
  return `[Imported web chat · ${transcript.source.kind} · partial=${partial} · ${transcript.source.capturedAt}]\n\n`
}

const GENERIC_IMPORT_TITLE = /^(deepseek|shared conversation|imported chat|chat|untitled|未命名)$/i

/** Sidebar title for imported sessions (avoids generic page titles / 未命名). */
export function resolveWebChatImportTitle(transcript: WebChatTranscript): string {
  const raw = transcript.title.trim()
  if (raw !== '' && !GENERIC_IMPORT_TITLE.test(raw)) {
    return raw.length <= 80 ? raw : `${raw.slice(0, 79)}…`
  }
  const firstUser = transcript.turns.find(turn => turn.role === 'user')
  if (firstUser !== undefined) {
    const text = firstUser.text.trim().replace(/\s+/g, ' ')
    if (text !== '') {
      return text.length <= 40 ? text : `${text.slice(0, 39)}…`
    }
  }
  if (raw !== '') return raw
  return 'Imported chat'
}

function closeOpenTurn(session: Session, turn: number): void {
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function appendUserMessage(
  session: Session,
  text: string,
): SessionEvent {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  return session.append('user/message', message, { surfaceOp: 'append' })
}

function appendSessionTitle(
  session: Session,
  title: string,
  firstUserMessageSeq: number | undefined,
): void {
  const trimmed = title.trim()
  if (trimmed === '') return
  session.append('session/title', {
    title: trimmed,
    messageSeqs: firstUserMessageSeq === undefined ? [] : [SessionSeq(firstUserMessageSeq)],
    source: { kind: 'fallback' },
  })
}

function appendAssistantMessage(
  session: Session,
  turn: number,
  step: number,
  text: string,
): void {
  session.append('step/start', { turn, step })
  const message = createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'web-chat-bridge', model: 'imported-history' },
  })
  session.append('assistant/message', {
    turn,
    step,
    message,
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
}

/** Inert protected head so later system-prompt projection can replace it. */
function appendProtectedSystemHead(
  session: Session,
  turn: number,
  step: number,
): void {
  session.append('step/start', { turn, step })
  session.append('system/message', {
    turn,
    step,
    message: createSystemMessage(''),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
}

/** Append imported turns with explicit turn/step boundaries for consecutive roles. */
export function appendTranscript(session: Session, transcript: WebChatTranscript): void {
  const provenance = importProvenancePrefix(transcript)
  const turns = transcript.turns
  let turn = 1
  let step = 1
  let openTurn = true
  let awaitingAssistant = false
  let firstUser = true
  let firstUserMessageSeq: number | undefined

  // First surface must be system/message while surface is empty (v4 protected head).
  session.append('turn/start', { turn })
  appendProtectedSystemHead(session, turn, step)

  for (let index = 0; index < turns.length; index += 1) {
    const chatTurn = turns[index]!
    const nextRole = turns[index + 1]?.role

    if (chatTurn.role === 'user') {
      if (awaitingAssistant) {
        closeOpenTurn(session, turn)
        awaitingAssistant = false
        openTurn = false
        step = 0
      }
      if (!openTurn) {
        turn += 1
        step = 0
        session.append('turn/start', { turn })
        openTurn = true
      }
      const body = firstUser ? `${provenance}${chatTurn.text}` : chatTurn.text
      const userEvent = appendUserMessage(session, body)
      if (firstUser && userEvent !== null && typeof userEvent === 'object') {
        const seq = Number(Reflect.get(userEvent, 'seq'))
        if (Number.isFinite(seq)) firstUserMessageSeq = seq
      }
      awaitingAssistant = true
      firstUser = false
      continue
    }

    if (chatTurn.role === 'assistant') {
      if (!openTurn) {
        turn += 1
        step = 0
        session.append('turn/start', { turn })
        openTurn = true
        awaitingAssistant = false
      }
      step += 1
      appendAssistantMessage(session, turn, step, chatTurn.text)
      awaitingAssistant = false
      if (nextRole !== 'assistant') {
        closeOpenTurn(session, turn)
        openTurn = false
        step = 0
      }
    }
  }

  if (openTurn) closeOpenTurn(session, turn)
  appendSessionTitle(session, resolveWebChatImportTitle(transcript), firstUserMessageSeq)
}

/**
 * Transcript log used as `agents.create({ seed })`.
 * Events match `appendTranscript` (including the closing `turn/end`) with contiguous seqs.
 */
export function buildWebChatImportSeed(transcript: WebChatTranscript): SessionEvent[] {
  const events: SessionEvent[] = []
  const recorder = {
    append(type: string, data: unknown, intent?: { surfaceOp?: 'append' }): SessionEvent {
      const event = {
        type,
        seq: SessionSeq(events.length),
        time: Date.now(),
        data,
        ...(intent?.surfaceOp === undefined ? {} : { surfaceOp: intent.surfaceOp }),
      } as SessionEvent
      events.push(event)
      return event
    },
  }
  appendTranscript(recorder as unknown as Session, transcript)
  return events
}

interface OpenedAgentSession {
  readonly session: Session
  dispose(): Promise<boolean>
}

function onceDispose(dispose: (() => Promise<void>) | undefined): () => Promise<boolean> {
  let settled = false
  return async () => {
    if (settled) return true
    if (dispose === undefined) return false
    settled = true
    try {
      await dispose()
      return true
    } catch {
      return false
    }
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function openAgentWorkSession(
  input: ImportWebChatHistoryNowInput,
  cwd: string,
): Promise<OpenedAgentSession> {
  const agents = input.agents
  if (typeof agents.createSession === 'function') {
    let created: { readonly agent: WebChatAgentSession, dispose?: () => Promise<void> }
    try {
      created = await agents.createSession({
        cwd,
        reusable: () => false,
      })
    } catch (error) {
      throw new WebChatImportError('import-failed', `Agent create failed: ${errorDetail(error)}`)
    }
    const session = created.agent?.session
    if (session === undefined) {
      throw new WebChatImportError('import-failed', 'Agent create did not return a session')
    }
    const dispose = onceDispose(created.dispose?.bind(created))
    try {
      appendTranscript(session, input.transcript)
    } catch (error) {
      const disposed = await dispose()
      throw new WebChatImportError(
        'import-failed',
        errorDetail(error),
        disposed ? undefined : session.id,
      )
    }
    return { session, dispose }
  }

  if (typeof agents.create !== 'function') {
    throw new WebChatImportError('import-failed', 'Agent registry is unavailable')
  }
  const sessionId = SessionId(`session-${randomUUID()}`)
  const seed = buildWebChatImportSeed(input.transcript)
  let handle: WebChatAgentHandle
  try {
    handle = await agents.create({
      sessionId,
      seed,
      meta: { cwd },
      ...(input.agentOptions === undefined ? {} : { agentOptions: input.agentOptions }),
    })
  } catch (error) {
    throw new WebChatImportError('import-failed', `Agent create failed: ${errorDetail(error)}`)
  }
  const session = handle.agent?.session
  if (session === undefined) {
    throw new WebChatImportError('import-failed', 'Agent create did not return a session', sessionId)
  }
  return { session, dispose: onceDispose(() => handle.dispose()) }
}

export async function importWebChatHistoryNow(
  input: ImportWebChatHistoryNowInput,
): Promise<ImportWebChatHistoryNowResult> {
  assertTranscript(input.transcript)
  const cwd = resolve(input.cwd)
  const opened = await openAgentWorkSession(input, cwd)
  try {
    const flushed = await input.sessions.flush(opened.session)
    if (flushed !== true) {
      const disposed = await opened.dispose()
      throw new WebChatImportError(
        'import-failed',
        'Session flush did not persist',
        disposed ? undefined : opened.session.id,
      )
    }
    if (input.attachToWorkspace !== undefined) {
      try {
        await input.attachToWorkspace(opened.session.id)
      } catch (error) {
        const disposed = await opened.dispose()
        const detail = errorDetail(error)
        throw new WebChatImportError(
          'import-failed',
          disposed
            ? `Workspace attach failed: ${detail}`
            : `Workspace attach failed: ${detail}; dispose session ${opened.session.id} manually`,
          disposed ? undefined : opened.session.id,
        )
      }
    }
  } catch (error) {
    if (error instanceof WebChatImportError) throw error
    const disposed = await opened.dispose()
    throw new WebChatImportError(
      'import-failed',
      errorDetail(error),
      disposed ? undefined : opened.session.id,
    )
  }
  return { sessionId: opened.session.id }
}

type WorkspaceRegistryHost = {
  readonly list: () => readonly {
    readonly id: string
    readonly title?: string
    readonly path?: string
    readonly sessionIds?: readonly string[]
    readonly attachSession?: (sessionId: SessionId) => Promise<void>
  }[]
  readonly get?: (id: string) => {
    readonly id: string
    readonly title?: string
    readonly path?: string
    readonly attachSession?: (sessionId: SessionId) => Promise<void>
  } | undefined
  readonly create?: (path: string, title?: string) => Promise<{
    readonly id: string
    readonly title?: string
    readonly path?: string
  }>
}

export interface CreateWebChatWorkspaceResult {
  /** True when the user cancelled the folder picker. */
  readonly cancelled: boolean
  readonly workspace: WebChatWorkspaceRow | null
}

function workspaceRegistryOf(ctx: Context): WorkspaceRegistryHost | undefined {
  const registry = serviceOf(ctx, 'workspaceRegistry') as Partial<WorkspaceRegistryHost> | undefined
  if (registry === undefined || typeof registry.list !== 'function') return undefined
  return registry as WorkspaceRegistryHost
}

function workspacesFromStorage(ctx: Context): WebChatWorkspaceRow[] {
  const facility = serviceOf(ctx, 'storageDomain') as {
    get?: (name: string) => {
      table?: (name: string) => {
        entries: () => Iterable<[string, { title?: string, path?: string, cwd?: string }]>
      }
    } | undefined
  } | undefined
  const domain = facility?.get?.('workspace')
  const table = domain?.table?.('workspaces')
  if (table === undefined) return []
  const rows: WebChatWorkspaceRow[] = []
  for (const [id, record] of table.entries()) {
    const cwd = record?.path ?? record?.cwd
    if (typeof cwd !== 'string' || cwd.trim() === '') continue
    rows.push({
      id,
      title: record.title?.trim() || id,
      cwd: resolve(cwd),
    })
  }
  return rows
}

export function listWebChatWorkspacesNow(ctx: Context): WebChatWorkspaceRow[] {
  const registry = workspaceRegistryOf(ctx)
  if (registry !== undefined) {
    const rows: WebChatWorkspaceRow[] = []
    for (const workspace of registry.list()) {
      const cwd = workspace.path
      if (typeof cwd !== 'string' || cwd.trim() === '') continue
      rows.push({
        id: workspace.id,
        title: workspace.title?.trim() || workspace.id,
        cwd: resolve(cwd),
      })
    }
    if (rows.length > 0) return rows
  }
  return workspacesFromStorage(ctx)
}

/**
 * Pick a folder and register it as a Desktop workspace for web-chat import.
 * Cancelled pickers return `{ cancelled: true, workspace: null }` (not an error).
 */
export async function createWebChatWorkspaceNow(
  ctx: Context,
  signal: AbortSignal,
): Promise<CreateWebChatWorkspaceResult> {
  signal.throwIfAborted()
  const picked = await pickDirectoryNow(signal)
  if (picked.path === null) {
    return { cancelled: true, workspace: null }
  }
  signal.throwIfAborted()
  const absolute = resolve(picked.path)
  try {
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new WebChatImportError(
        'import-failed',
        `Selected folder does not exist: ${absolute}`,
      )
    }
  } catch (error) {
    if (error instanceof WebChatImportError) throw error
    throw new WebChatImportError(
      'import-failed',
      `Selected folder is not readable: ${absolute}`,
    )
  }
  const registry = workspaceRegistryOf(ctx)
  if (registry?.create === undefined) {
    throw new WebChatImportError('import-failed', 'Workspace registry cannot create workspaces')
  }
  let created: { readonly id: string, readonly title?: string, readonly path?: string }
  try {
    created = await registry.create(absolute)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    // Creating an already-registered path typically rejects; reuse that row when present.
    const existing = listWebChatWorkspacesNow(ctx).find(row => {
      try {
        return resolve(row.cwd) === absolute
      } catch {
        return false
      }
    })
    if (existing !== undefined) {
      return { cancelled: false, workspace: existing }
    }
    throw new WebChatImportError('import-failed', detail || 'Failed to create workspace')
  }
  const cwd = typeof created.path === 'string' && created.path.trim() !== ''
    ? resolve(created.path)
    : absolute
  return {
    cancelled: false,
    workspace: {
      id: created.id,
      title: created.title?.trim() || created.id,
      cwd,
    },
  }
}

function resolveWorkspace(ctx: Context, workspaceId: string): WebChatWorkspaceRow {
  const registry = workspaceRegistryOf(ctx)
  if (registry?.get !== undefined) {
    const workspace = registry.get(workspaceId)
    if (workspace !== undefined) {
      const cwd = workspace.path
      if (typeof cwd === 'string' && cwd.trim() !== '') {
        return {
          id: workspace.id,
          title: workspace.title?.trim() || workspace.id,
          cwd: resolve(cwd),
        }
      }
    }
  }
  const fromList = listWebChatWorkspacesNow(ctx).find(row => row.id === workspaceId)
  if (fromList !== undefined) return fromList
  throw new WebChatImportError('no-workspace', `Workspace "${workspaceId}" was not found`)
}

async function attachToWorkspaceRegistry(
  ctx: Context,
  workspaceId: string,
  sessionId: SessionId,
): Promise<void> {
  const registry = workspaceRegistryOf(ctx)
  const workspace = registry?.get?.(workspaceId)
  if (workspace?.attachSession !== undefined) {
    await workspace.attachSession(sessionId)
    return
  }
  const facility = serviceOf(ctx, 'storageDomain') as {
    get?: (name: string) => {
      table?: (name: string) => {
        update: (id: string, next: (current: unknown) => unknown) => Promise<void>
      }
    } | undefined
  } | undefined
  const domain = facility?.get?.('workspace')
  const table = domain?.table?.('workspaces')
  if (table === undefined) {
    throw new WebChatImportError('import-failed', 'Workspace registry is unavailable for attach')
  }
  await table.update(workspaceId, current => {
    const row = current as { sessionIds?: string[], title?: string, path?: string, updatedAt?: string }
    const sessionIds = Array.isArray(row.sessionIds) ? row.sessionIds : []
    if (sessionIds.includes(sessionId)) return row
    return {
      ...row,
      sessionIds: [...sessionIds, sessionId],
      updatedAt: new Date().toISOString(),
    }
  })
}

function agentOptionsOf(ctx: Context): WebChatAgentOptions | undefined {
  const defaults = serviceOf(ctx, 'agentDefaultModel') as {
    currentSelection?: () => { provider?: string, model?: string, reasoningEffort?: string }
  } | undefined
  if (typeof defaults?.currentSelection !== 'function') return undefined
  const current = defaults.currentSelection.bind(defaults)
  return {
    get provider() { return current().provider },
    get model() { return current().model },
    get reasoningEffort() { return current().reasoningEffort },
  }
}

export async function importWebChatHistoryWithContext(
  ctx: Context,
  request: ImportWebChatHistoryRequest,
): Promise<ImportWebChatHistoryNowResult> {
  const workspace = resolveWorkspace(ctx, request.workspaceId)
  const sessions = serviceOf(ctx, 'sessions') as { flush?: (session: Session) => Promise<boolean> } | undefined
  const agents = serviceOf(ctx, 'agents') as WebChatWorkAgents | undefined
  if (sessions === undefined || typeof sessions.flush !== 'function') {
    throw new WebChatImportError('import-failed', 'Session store is unavailable')
  }
  if (
    agents === undefined
    || (typeof agents.createSession !== 'function' && typeof agents.create !== 'function')
  ) {
    throw new WebChatImportError('import-failed', 'Agent registry is unavailable')
  }
  const agentOptions = agentOptionsOf(ctx)
  return importWebChatHistoryNow({
    sessions: { flush: session => sessions.flush!(session) },
    agents,
    ...(agentOptions === undefined ? {} : { agentOptions }),
    workspaceId: workspace.id,
    cwd: workspace.cwd,
    transcript: request.transcript,
    attachToWorkspace: sessionId => attachToWorkspaceRegistry(ctx, workspace.id, sessionId),
  })
}
