import { randomUUID } from 'node:crypto'
import { MessageId, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { blockingUnavailable } from './availability.ts'
import type { CheckpointRollbackScope, CheckpointUnavailable } from './availability.ts'
import { resolveRollbackCut, synthesizeCheckpoint } from './capture.ts'
import { CheckpointFileError, CheckpointFiles } from './files.ts'
import type { CheckpointFileOperations, FileConflict, RestoreDirection } from './files.ts'
import type { CheckpointStore } from './store.ts'
import type { Checkpoint } from './types.ts'

export type { CheckpointRollbackScope, CheckpointUnavailable } from './availability.ts'
export { blockingUnavailable, isConversationSoftUnavailable } from './availability.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'checkpoint-rollback': {
      kind: 'checkpoint-rollback'
      form: 'notice'
      summary: string
    }
  }
}

const ROLLBACK_PREFIX = 'dsh-composer-enhancer:rollback:'
const UNDO_PREFIX = 'dsh-composer-enhancer:undo:'
const surfaceEventTypes = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

type SurfaceMessageEvent = SessionEvent<'system/message' | 'developer/message' | 'user/message' | 'assistant/message' | 'tool/result'>

export type CheckpointRollbackOperation = 'rollback' | 'undo'

export interface CheckpointRollbackRequest {
  readonly sessionId: SessionId
  readonly turn: number
  readonly operation?: CheckpointRollbackOperation
  readonly scope?: CheckpointRollbackScope
}

export interface CheckpointMessagePreview {
  readonly seq: number
  readonly type: string
  readonly text: string
}

export interface CheckpointFilePreview {
  readonly path: string
  readonly change: 'create' | 'modify' | 'delete'
}

export interface CheckpointRollbackPreview extends CheckpointRollbackRequest {
  readonly messages: readonly CheckpointMessagePreview[]
  readonly files: readonly CheckpointFilePreview[]
  readonly conflicts: readonly FileConflict[]
  readonly unavailable: readonly CheckpointUnavailable[]
}

export interface CheckpointRollbackResult extends CheckpointRollbackRequest {
  readonly draft: string
}

export type CheckpointRollbackErrorCode =
  | 'ROLLBACK_UNAVAILABLE'
  | 'ROLLBACK_CONFLICT'
  | 'ROLLBACK_FAILED'
  | 'ROLLBACK_RECOVERY_FAILED'

export class CheckpointRollbackError extends Error {
  constructor(
    readonly code: CheckpointRollbackErrorCode,
    readonly unavailable: readonly CheckpointUnavailable[] = [],
    readonly conflicts: readonly FileConflict[] = [],
  ) {
    super(code)
    this.name = 'CheckpointRollbackError'
  }
}

export interface CheckpointServiceSession {
  readonly session: Session
  readonly workspaceRoot: string
  readonly status: 'idle' | 'running'
  readonly canRestore: boolean
  readEvents(): readonly SessionEvent[]
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  synchronize(signal: AbortSignal): Promise<void>
}

export interface CheckpointRollbackServiceOptions {
  readonly store: CheckpointStore
  readonly storageRoot: string
  readonly pluginVersion: string
  readonly resolveSession: (sessionId: SessionId) => CheckpointServiceSession | undefined
  readonly isEnabled?: () => boolean
  readonly operations?: CheckpointFileOperations
  readonly createId?: () => string
  readonly now?: () => number
  /** Wait for in-flight turn captures before reading the checkpoint store. */
  readonly awaitCaptures?: () => Promise<void>
}

interface RollbackSurface {
  readonly operation: 'rollback'
  /** Checkpoint turn the user restored to — stable across later undo shells. */
  readonly turn: number
  readonly nodes: readonly SessionSeq[]
}

interface UndoSurface {
  readonly operation: 'undo'
  readonly marker: SessionEvent<'user/message'>
  readonly sources: readonly SurfaceMessageEvent[]
}

interface Evaluation {
  readonly checkpoint: Checkpoint | null
  readonly adapter: CheckpointServiceSession | null
  readonly surface: RollbackSurface | UndoSurface | null
  readonly preview: CheckpointRollbackPreview
}

function rollbackMarkerId(turn: number, journalId: string, scope: CheckpointRollbackScope): MessageId {
  const tag = scope === 'conversation' ? 'c:' : ''
  return MessageId(`${ROLLBACK_PREFIX}${turn}:${tag}${journalId}`)
}

function undoCopyId(journalId: string, index: number): MessageId {
  return MessageId(`${UNDO_PREFIX}${journalId}:${index}`)
}

function rollbackIdOf(id: string): string {
  const start = id.indexOf(ROLLBACK_PREFIX)
  return start >= 0 ? id.slice(start) : id
}

function scopeOfMarkerId(id: string): CheckpointRollbackScope {
  return new RegExp(`^${ROLLBACK_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+:c:`).test(rollbackIdOf(id))
    ? 'conversation'
    : 'conversation-and-files'
}

function scopeOfMarker(event: SessionEvent<'user/message'>): CheckpointRollbackScope {
  return scopeOfMarkerId(event.data.id)
}

function isRollbackMarker(event: SessionEvent | undefined, turn?: number): event is SessionEvent<'user/message'> {
  if (event?.type !== 'user/message' || event.data.source.kind !== 'checkpoint-rollback'
    || event.data.source.form !== 'notice' || event.data.content.length === 0) return false
  const prefix = turn === undefined ? ROLLBACK_PREFIX : `${ROLLBACK_PREFIX}${turn}:`
  if (event.data.id.startsWith(prefix)) return true
  if (!event.data.id.startsWith(UNDO_PREFIX)) return false
  const original = event.data.id.indexOf(ROLLBACK_PREFIX)
  return original >= 0 && event.data.id.slice(original).startsWith(prefix)
}

function surfaceMessageId(event: SessionEvent): MessageId | null {
  switch (event.type) {
    case 'user/message': return event.data.id
    case 'system/message':
    case 'developer/message':
    case 'assistant/message':
    case 'tool/result': return event.data.message.id
    default: return null
  }
}

function isUndoCopy(event: SessionEvent): boolean {
  return surfaceMessageId(event)?.startsWith(UNDO_PREFIX) ?? false
}

function isUndoCopyAt(event: SessionEvent, expected: MessageId): boolean {
  const id = surfaceMessageId(event)
  return id === expected || (id?.startsWith(`${expected}:`) ?? false)
}

function logicalSeq(event: SessionEvent): SessionSeq {
  if (isUndoCopy(event)) {
    const match = surfaceMessageId(event)?.match(/:(\d+)(?::dsh-composer-enhancer:rollback:.*)?$/)
    if (match !== null && match !== undefined) return SessionSeq(Number(match[1]))
  }
  return event.seq
}

function isOwnReplacement(event: SessionEvent): boolean {
  return isRollbackMarker(event) || isUndoCopy(event)
}

/**
 * Desktop appends the protected system prompt after `turn/start` (during step prep).
 * Session forbids replacing that node with a user/message marker — rolling it back
 * always fails with a surface-replace error. Keep system prompts on the surface.
 */
function isProtectedSystemMessage(event: SessionEvent | undefined): boolean {
  return event?.type === 'system/message'
}

function rollbackSurfaceNodes(
  events: readonly SessionEvent[],
  candidates: readonly SessionSeq[],
): SessionSeq[] {
  return candidates.filter(node => !isProtectedSystemMessage(events[node]))
}

function abortError(): DOMException {
  return new DOMException('Checkpoint rollback was cancelled', 'AbortError')
}

function textOf(event: SessionEvent): string {
  switch (event.type) {
    case 'user/message':
      return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    case 'system/message':
    case 'developer/message':
    case 'assistant/message':
    case 'tool/result':
      return event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    default: return ''
  }
}

function operationOf(request: CheckpointRollbackRequest): CheckpointRollbackOperation {
  return request.operation ?? 'rollback'
}

function scopeOf(request: CheckpointRollbackRequest): CheckpointRollbackScope {
  return request.scope ?? 'conversation-and-files'
}

function directionOf(operation: CheckpointRollbackOperation): RestoreDirection {
  return operation === 'rollback' ? 'rollback' : 'undo'
}

function sourceEvents(
  events: readonly SessionEvent[],
  marker: SessionEvent<'user/message'>,
): readonly SurfaceMessageEvent[] | null {
  if (marker.surfaceOp === 'append') {
    if (marker.sourceEventSeqs?.length !== 1) return null
    const original = events[marker.sourceEventSeqs[0]!]
    return isRollbackMarker(original) ? sourceEvents(events, original) : null
  }
  if (marker.sourceEventSeqs === undefined || marker.sourceEventSeqs.length === 0) return null
  const sources: SurfaceMessageEvent[] = []
  for (const seq of marker.sourceEventSeqs) {
    const event = events[seq]
    if (event === undefined || !surfaceEventTypes.has(event.type)) return null
    sources.push(event as SurfaceMessageEvent)
  }
  if (sources[0]?.type !== 'user/message') return null
  return sources
}

/**
 * Session format requires monotonic turn ids. Re-opening the rolled-back turn
 * fails on reload (`turn/start does not open the expected turn`). Undo opens
 * the next unused turn instead.
 */
function nextTurnNumber(events: readonly SessionEvent[]): number {
  let max = 0
  for (const event of events) {
    if (event.type === 'turn/start') max = Math.max(max, event.data.turn)
  }
  return max + 1
}

/** Turn opened for a partially appended undo (recovery resumes inside it). */
function undoTurnAfterMarker(
  events: readonly SessionEvent[],
  markerSeq: SessionSeq,
): number {
  for (const event of events) {
    if (Number(event.seq) > Number(markerSeq) && event.type === 'turn/start') {
      return event.data.turn
    }
  }
  throw new Error('Partial undo is missing its turn/start')
}

function isUndoTurnChrome(event: SessionEvent): boolean {
  return event.type === 'turn/start' || event.type === 'turn/end'
    || event.type === 'step/start' || event.type === 'step/end'
}

interface UndoToolCall {
  readonly callId: ToolCallId
  readonly name: string
  readonly arguments: string
}

function toolCallsOf(event: SessionEvent<'assistant/message'>): readonly UndoToolCall[] {
  const calls: UndoToolCall[] = []
  for (const block of event.data.message.content) {
    if (block.type !== 'tool-call') continue
    calls.push({ callId: block.id, name: block.name, arguments: block.arguments })
  }
  return calls
}

/**
 * V4 format tracks tool lifecycle across the physical log: assistant advertises
 * a call, `tool/call` marks it started, `tool/result` settles it. Undo only
 * re-copies surface messages, so without synthetic `tool/call` rows a restored
 * `tool/result` looks like a not-started repair and fails reload validation
 * (`not-started error requires an object`).
 */
function appendUndoToolCalls(
  session: Session,
  calls: readonly UndoToolCall[],
  turn: number,
  step: number,
  openCalls: Map<string, UndoToolCall>,
): void {
  for (const call of calls) {
    session.append('tool/call', {
      turn,
      step,
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
    })
    openCalls.set(String(call.callId), call)
  }
}

function settleOpenUndoToolCalls(
  session: Session,
  journalId: string,
  turn: number,
  step: number,
  openCalls: Map<string, UndoToolCall>,
): void {
  for (const call of openCalls.values()) {
    session.append('tool/result', {
      turn,
      step,
      message: {
        id: MessageId(`${UNDO_PREFIX}${journalId}:orphan:${call.callId}`),
        role: 'tool',
        source: { kind: 'tool', callId: call.callId },
        toolCallId: call.callId,
        isError: true,
        content: [{
          type: 'text',
          text: 'The tool call was restored without a recorded result.',
        }],
      },
      error: {
        name: 'UndoOrphanToolCall',
        code: 'UNDO_ORPHAN_TOOL_CALL',
        reason: 'Restored assistant tool call had no matching tool/result in the rollback surface.',
      },
    }, { surfaceOp: 'append' })
  }
  openCalls.clear()
}

/**
 * After a crash mid-undo, assistant copies may already advertise tool calls
 * without their synthetic `tool/call` rows. Emit any missing starts before
 * resuming so the next `tool/result` copy is not treated as not-started.
 */
function ensureCopiedAssistantToolCalls(
  session: Session,
  events: readonly SessionEvent[],
  journalId: string,
  completed: number,
  turn: number,
  step: number,
  openCalls: Map<string, UndoToolCall>,
): void {
  const first = events.find(event => isUndoCopyAt(event, undoCopyId(journalId, 0)))
  if (first === undefined) return
  const undoStart = Number(first.seq)
  const started = new Set<string>()
  const settled = new Set<string>()
  for (const event of events) {
    if (Number(event.seq) < undoStart) continue
    if (event.type === 'tool/call') started.add(String(event.data.callId))
    if (event.type === 'tool/result') settled.add(String(event.data.message.toolCallId))
  }
  for (let index = 0; index < completed; index += 1) {
    const event = events.find(candidate => isUndoCopyAt(candidate, undoCopyId(journalId, index)))
    if (event?.type !== 'assistant/message') continue
    const calls = toolCallsOf(event)
    appendUndoToolCalls(
      session,
      calls.filter(call => !started.has(String(call.callId))),
      turn,
      step,
      openCalls,
    )
    for (const call of calls) {
      if (!settled.has(String(call.callId))) openCalls.set(String(call.callId), call)
    }
  }
}

/** Count contiguous undo copies from `first`, allowing synthetic `tool/call` gaps. */
function countPartialUndoCopies(
  events: readonly SessionEvent[],
  first: SessionEvent,
  journalId: string,
  tip: number,
): number {
  let completed = 0
  let cursor = Number(first.seq)
  while (cursor <= tip) {
    const event = events[SessionSeq(cursor)]
    if (event === undefined) throw new CheckpointRollbackError('ROLLBACK_RECOVERY_FAILED')
    if (isUndoCopyAt(event, undoCopyId(journalId, completed))) {
      completed += 1
      cursor += 1
      continue
    }
    if (event.type === 'tool/call' && completed > 0) {
      cursor += 1
      continue
    }
    throw new CheckpointRollbackError('ROLLBACK_RECOVERY_FAILED')
  }
  return completed
}

function appendUndoCopy(
  session: Session,
  source: SurfaceMessageEvent,
  journalId: string,
  index: number,
  markerSeq: SessionSeq,
  turn: number,
  step: number,
  openCalls: Map<string, UndoToolCall>,
): SessionEvent {
  const copyId = MessageId(`${undoCopyId(journalId, index)}:${source.seq}`)
  const id = isRollbackMarker(source) ? MessageId(`${copyId}:${source.data.id}`) : copyId
  if (source.type === 'user/message') {
    return session.append('user/message', { ...source.data, id }, index === 0 ? {
      surfaceOp: { op: 'replace', startSeq: markerSeq, endSeq: markerSeq },
      sourceEventSeqs: [markerSeq, source.seq],
    } : {
      surfaceOp: 'append',
      sourceEventSeqs: [source.seq],
    })
  }
  if (index === 0) throw new Error('The first restored surface event must be a user message')
  switch (source.type) {
    case 'assistant/message': {
      const event = session.append('assistant/message', {
        ...source.data,
        turn,
        step,
        message: { ...source.data.message, id },
      }, { surfaceOp: 'append' })
      appendUndoToolCalls(session, toolCallsOf(source), turn, step, openCalls)
      return event
    }
    case 'system/message':
      return session.append('system/message', {
        ...source.data,
        turn,
        step,
        message: { ...source.data.message, id },
      }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
    case 'developer/message':
      return session.append('developer/message', {
        ...source.data,
        turn,
        step,
        message: { ...source.data.message, id },
      }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
    case 'tool/result': {
      openCalls.delete(String(source.data.message.toolCallId))
      return session.append('tool/result', {
        ...source.data,
        turn,
        step,
        message: { ...source.data.message, id },
      }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
    }
  }
}

export class CheckpointRollbackService {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private recovery: Promise<void> | undefined
  private closing: Promise<void> | undefined

  constructor(private readonly options: CheckpointRollbackServiceOptions) {}

  preview(request: CheckpointRollbackRequest, signal?: AbortSignal): Promise<CheckpointRollbackPreview> {
    return this.track(this.runPreview(request, signal))
  }

  execute(request: CheckpointRollbackRequest, signal?: AbortSignal): Promise<CheckpointRollbackResult> {
    return this.track(this.runExecute(request, signal))
  }

  recover(): Promise<void> {
    if (this.recovery !== undefined) return this.recovery
    const operation = this.track(this.runRecovery())
    this.recovery = operation
    return operation.finally(() => {
      if (this.recovery === operation) this.recovery = undefined
    })
  }

  close(): Promise<void> {
    if (this.closing === undefined) {
      this.lifetime.abort(abortError())
      this.closing = Promise.allSettled([...this.pending]).then(() => undefined)
    }
    return this.closing
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    return operation.finally(() => { this.pending.delete(operation) })
  }

  private linkedSignal(signals: readonly (AbortSignal | undefined)[]): {
    signal: AbortSignal
    cleanup: () => void
  } {
    const controller = new AbortController()
    const listeners: Array<{ signal: AbortSignal, abort: () => void }> = []
    for (const signal of [this.lifetime.signal, ...signals]) {
      if (signal === undefined) continue
      const abort = () => { controller.abort(signal.reason ?? abortError()) }
      if (signal.aborted) abort()
      else {
        signal.addEventListener('abort', abort, { once: true })
        listeners.push({ signal, abort })
      }
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        for (const { signal, abort } of listeners) signal.removeEventListener('abort', abort)
      },
    }
  }

  private async runPreview(
    request: CheckpointRollbackRequest,
    callerSignal?: AbortSignal,
  ): Promise<CheckpointRollbackPreview> {
    const linked = this.linkedSignal([callerSignal])
    try {
      linked.signal.throwIfAborted()
      if ((await this.options.store.listPendingJournals()).length > 0) {
        throw new CheckpointRollbackError('ROLLBACK_RECOVERY_FAILED')
      }
      linked.signal.throwIfAborted()
      return (await this.evaluate(request)).preview
    } catch (error) {
      throw this.sanitize(error, linked.signal)
    } finally {
      linked.cleanup()
    }
  }

  private async runExecute(
    request: CheckpointRollbackRequest,
    callerSignal?: AbortSignal,
  ): Promise<CheckpointRollbackResult> {
    const linked = this.linkedSignal([callerSignal])
    try {
      linked.signal.throwIfAborted()
      await this.options.store.recoverInterruptedWrites(request.sessionId)
      await this.recover()
      linked.signal.throwIfAborted()
      const initial = await this.evaluate(request)
      const initialScope = this.effectiveScope(request, initial)
      this.assertExecutable(initial, initialScope)
      const adapter = initial.adapter!
      const result = await adapter.runMaintenance(async maintenanceSignal => {
        const maintenance = this.linkedSignal([linked.signal, maintenanceSignal])
        try {
          maintenance.signal.throwIfAborted()
          // Inside maintenance the agent is often not "idle"; skip the running check.
          const current = await this.evaluate(request, { withinMaintenance: true })
          const scope = this.effectiveScope(request, current)
          this.assertExecutable(current, scope)
          if (current.adapter?.session !== adapter.session || current.surface === null) {
            throw new CheckpointRollbackError('ROLLBACK_UNAVAILABLE', ['session-changed'])
          }
          const checkpoint = current.checkpoint!
          const operation = operationOf(request)
          const session = adapter.session
          const expectedSeq = session.seq
          const expectedNodes = [...session.surface.nodes]
          const journalId = (this.options.createId ?? randomUUID)()
          const files = this.files(adapter, checkpoint, journalId)
          const filesToRestore = scope === 'conversation' ? [] : checkpoint.files
          await files.runTransaction(filesToRestore, async () => {
            if (maintenance.signal.aborted) return { appended: false, synchronized: false }
            const latest = this.options.resolveSession(request.sessionId)
            // Same Session id can still mean a replaced Session object — compare by reference.
            if (latest?.session !== session || !this.canCommit(adapter, scope) || session.seq !== expectedSeq
              || session.surface.nodes.length !== expectedNodes.length
              || session.surface.nodes.some((node, index) => node !== expectedNodes[index])) {
              return { appended: false, synchronized: false }
            }
            const restored = await this.appendAndSynchronize(
              adapter, current.surface!, journalId, scope, maintenance.signal,
            )
            // Preserve the real append flag: a sync failure must leave the journal
            // pending (files-restored) instead of compensating away a committed surface.
            const appended = restored.appended && this.appendOccurred(adapter, journalId)
            return { appended, synchronized: appended && restored.synchronized }
          }, directionOf(operation))
          return {
            sessionId: request.sessionId,
            turn: request.turn,
            draft: operation === 'rollback' ? checkpoint.prompt : '',
          }
        } catch (error) {
          throw this.sanitize(error, maintenance.signal)
        } finally {
          maintenance.cleanup()
        }
      })
      // Re-project after the maintenance lock drops so client views are not held back.
      // The surface is already committed; a late projection miss must not undo success.
      linked.signal.throwIfAborted()
      try {
        await adapter.synchronize(linked.signal)
      } catch {
        if (linked.signal.aborted) throw this.sanitize(abortError(), linked.signal)
      }
      return result
    } catch (error) {
      throw this.sanitize(error, linked.signal)
    } finally {
      linked.cleanup()
    }
  }

  private async appendAndSynchronize(
    adapter: CheckpointServiceSession,
    surface: RollbackSurface | UndoSurface,
    journalId: string,
    scope: CheckpointRollbackScope,
    signal: AbortSignal,
  ): Promise<{ appended: boolean, synchronized: boolean }> {
    try {
      if (surface.operation === 'rollback') this.appendRollback(adapter, surface, journalId, scope)
      else this.appendUndo(adapter.session, surface.marker, surface.sources, journalId)
    } catch {
      return { appended: this.appendOccurred(adapter, journalId), synchronized: false }
    }
    try {
      await adapter.synchronize(signal)
      return { appended: true, synchronized: true }
    } catch {
      return { appended: true, synchronized: false }
    }
  }

  private appendRollback(
    adapter: CheckpointServiceSession,
    surface: RollbackSurface,
    journalId: string,
    scope: CheckpointRollbackScope,
  ): void {
    const checkpointTurn = surface.turn
    const conversationOnly = scope === 'conversation'
    const summary = conversationOnly
      ? `Conversation rolled back before turn ${checkpointTurn}`
      : `Conversation and tracked files rolled back before turn ${checkpointTurn}`
    const detail = conversationOnly
      ? `The user rolled back the conversation to before turn ${checkpointTurn}. `
        + 'Later events remain in the append-only log but are no longer active model context. '
        + 'Tracked files were not restored.'
      : `The user rolled back the conversation and tracked files to before turn ${checkpointTurn}. `
        + 'Later events remain in the append-only log but are no longer active model context. '
        + 'Re-read tracked files before relying on their contents.'
    adapter.session.append('user/message', {
      id: rollbackMarkerId(checkpointTurn, journalId, scope),
      role: 'user',
      content: [{ type: 'text', text: detail }],
      source: { kind: 'checkpoint-rollback', form: 'notice', summary },
    }, {
      surfaceOp: {
        op: 'replace',
        startSeq: surface.nodes[0]!,
        endSeq: surface.nodes[surface.nodes.length - 1]!,
      },
      sourceEventSeqs: [...surface.nodes],
    })
  }

  private appendUndo(
    session: Session,
    marker: SessionEvent<'user/message'>,
    sources: readonly SurfaceMessageEvent[],
    journalId: string,
    start = 0,
    openCalls = new Map<string, UndoToolCall>(),
  ): void {
    // Chat binds assistants to turn/step coordinates. Format validation also requires
    // an open step for assistant/message. Re-using the rolled-back turn id fails on
    // reload — always open the next monotonic turn with step 1.
    // Agent.runMaintenance freezes lastTurn across this append; DshCheckpointSessions
    // re-syncs idle lastTurn from turnBoundary afterward so the next prompt does not
    // reopen this shell's turn id (which would collapse the restored reply in Chat).
    const events = session.snapshotEvents()
    const turn = start === 0 ? nextTurnNumber(events) : undoTurnAfterMarker(events, marker.seq)
    const step = 1
    if (start === 0) {
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step })
    }
    for (let index = start; index < sources.length; index += 1) {
      appendUndoCopy(session, sources[index]!, journalId, index, marker.seq, turn, step, openCalls)
    }
    settleOpenUndoToolCalls(session, journalId, turn, step, openCalls)
    session.append('step/end', { turn, step })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  private async runRecovery(): Promise<void> {
    try {
      this.lifetime.signal.throwIfAborted()
      const journals = await this.options.store.recoverJournal()
      const sessionIds = [...new Set(journals.map(journal => journal.sessionId))]
      for (const sessionId of sessionIds) {
        await this.options.store.recoverInterruptedWrites(sessionId)
        const adapter = this.options.resolveSession(sessionId)
        if (adapter === undefined || adapter.status !== 'idle') {
          throw new CheckpointRollbackError('ROLLBACK_RECOVERY_FAILED')
        }
        await adapter.runMaintenance(async maintenanceSignal => {
          const linked = this.linkedSignal([maintenanceSignal])
          try {
            linked.signal.throwIfAborted()
            const files = new CheckpointFiles({
              workspaceRoot: adapter.workspaceRoot,
              storageRoot: this.options.storageRoot,
              store: this.options.store,
              sessionId,
              checkpointId: 'recovery',
              operations: this.options.operations,
              now: this.options.now,
            })
            await files.recoverFiles(async journal => {
              if (!this.appendOccurred(adapter, journal.id)) return false
              await this.resumeUndo(adapter, journal.id)
              await adapter.synchronize(linked.signal)
              return true
            })
          } finally {
            linked.cleanup()
          }
        })
      }
    } catch (error) {
      if (error instanceof CheckpointRollbackError) throw error
      throw new CheckpointRollbackError('ROLLBACK_RECOVERY_FAILED')
    }
  }

  private async resumeUndo(adapter: CheckpointServiceSession, journalId: string): Promise<void> {
    const events = adapter.readEvents()
    const first = events.find(event => isUndoCopyAt(event, undoCopyId(journalId, 0)))
    if (first === undefined) return
    if (first.type !== 'user/message' || first.surfaceOp === 'append'
      || first.surfaceOp.startSeq !== first.surfaceOp.endSeq) {
      throw new CheckpointRollbackError('ROLLBACK_RECOVERY_FAILED')
    }
    const marker = events[first.surfaceOp.startSeq]
    if (!isRollbackMarker(marker)) throw new CheckpointRollbackError('ROLLBACK_RECOVERY_FAILED')
    const sources = sourceEvents(events, marker)
    if (sources === null) throw new CheckpointRollbackError('ROLLBACK_RECOVERY_FAILED')
    const tip = Number(adapter.session.seq) - 1
    const completed = countPartialUndoCopies(events, first, journalId, tip)
    const openCalls = new Map<string, UndoToolCall>()
    const turn = undoTurnAfterMarker(events, marker.seq)
    const step = 1
    ensureCopiedAssistantToolCalls(
      adapter.session, events, journalId, completed, turn, step, openCalls,
    )
    this.appendUndo(adapter.session, marker, sources, journalId, completed, openCalls)
  }

  private async evaluate(
    request: CheckpointRollbackRequest,
    options: { readonly withinMaintenance?: boolean } = {},
  ): Promise<Evaluation> {
    const operation = operationOf(request)
    await this.options.awaitCaptures?.()
    const checkpoints = await this.options.store.list(request.sessionId)
    let stored = checkpoints.find(checkpoint => checkpoint.turn === request.turn) ?? null
    const adapter = this.options.resolveSession(request.sessionId) ?? null
    // Cancelled / raced turns often have no store entry yet — synthesize a soft
    // conversation checkpoint from the closed turn so restore stays available.
    if (stored === null && adapter !== null && operation === 'rollback') {
      stored = synthesizeCheckpoint({
        sessionId: request.sessionId,
        session: {
          format: adapter.session.header.version,
          preset: adapter.session.header.agentPreset ?? null,
        },
        pluginVersion: this.options.pluginVersion,
        turn: request.turn,
        events: adapter.readEvents(),
        createId: this.options.createId,
        now: this.options.now,
      })
    }
    const unavailable: CheckpointUnavailable[] = []
    if (stored === null) unavailable.push('checkpoint-not-found')
    if (adapter === null) unavailable.push('session-changed')
    if (this.options.isEnabled !== undefined && !this.options.isEnabled()) unavailable.push('rollback-disabled')
    if (adapter !== null) {
      // Only an actively running agent blocks restore. Other non-idle statuses
      // (stopping / settling after cancel) must not disable confirm buttons.
      if (!options.withinMaintenance && adapter.status === 'running') unavailable.push('session-running')
      if (!adapter.canRestore) unavailable.push('permission-denied')
      if (adapter.session.header.origin === 'subagent' || (adapter.session.header.delegationDepth ?? 0) > 0) {
        unavailable.push('subagent-session')
      }
    }
    if (stored !== null) {
      if (stored.coverage !== 'complete' || stored.gaps.length > 0) unavailable.push('incomplete-checkpoint')
      for (const gap of stored.gaps) {
        unavailable.push(gap.type === 'prompt' ? 'prompt-non-text-content' : 'workspace-capture-failed')
      }
      // Only the Session format is a hard structural incompatibility. Plugin
      // version and agent preset drift are common after upgrades and must not
      // strand conversation restore.
      if (adapter !== null && stored.session.format !== adapter.session.header.version) {
        unavailable.push('incompatible-session')
      }
    }
    let messages: CheckpointMessagePreview[] = []
    let surface: RollbackSurface | UndoSurface | null = null
    if (stored !== null && adapter !== null && stored.atSeq >= 0) {
      const events = adapter.readEvents()
      const cut = resolveRollbackCut(events, stored.turn, stored.atSeq)
      if (cut === null) {
        unavailable.push('unknown-surface')
      } else if (operation === 'rollback') {
        if (events.some(event => Number(event.seq) > cut.cutSeq && typeof event.surfaceOp === 'object'
          && !isOwnReplacement(event))) {
          unavailable.push('compacted-surface')
        }
        const fromSurface = adapter.session.surface.nodes
          .filter(node => Number(logicalSeq(events[node]!)) > cut.cutSeq)
        const fromLog = events
          .filter(event => Number(event.seq) > cut.cutSeq && surfaceEventTypes.has(event.type))
          .map(event => SessionSeq(event.seq))
        const candidates = (fromSurface.length > 0
          && fromSurface.every(node => events[node] !== undefined && surfaceEventTypes.has(events[node]!.type))
          ? fromSurface.map(node => SessionSeq(node))
          : fromLog)
        // Never include the protected system prompt — Desktop injects it after turn/start.
        const nodes = rollbackSurfaceNodes(events, candidates)
        if (nodes.length === 0) {
          unavailable.push('unknown-surface')
        } else {
          surface = { operation, turn: stored.turn, nodes }
          messages = nodes.map(node => ({
            seq: node,
            type: events[node]!.type,
            text: textOf(events[node]!),
          }))
        }
      } else {
        const currentNodes = adapter.session.surface.nodes
        const markerSeq = currentNodes[currentNodes.length - 1]
        const marker = markerSeq === undefined ? undefined : events[markerSeq]
        const origin = marker?.surfaceOp === 'append' && marker.sourceEventSeqs?.length === 1
          ? events[marker.sourceEventSeqs[0]!] : marker
        if (!isRollbackMarker(marker, stored.turn) || !isRollbackMarker(origin, stored.turn)
          || currentNodes.slice(0, -1).some(node => {
            const event = events[node]
            if (isProtectedSystemMessage(event)) return false
            return Number(logicalSeq(event!)) > cut.cutSeq
          })
          || events.slice(Number(origin.seq) + 1).some(event => !isRollbackMarker(event)
            && !isUndoCopy(event)
            && !isUndoTurnChrome(event))) {
          unavailable.push('session-changed')
        } else {
          const sources = sourceEvents(events, marker)
          if (sources === null || sources.some(event => Number(event.seq) <= cut.cutSeq)) {
            unavailable.push('unknown-surface')
          } else {
            surface = { operation, marker, sources }
            messages = sources.map(event => ({ seq: event.seq, type: event.type, text: textOf(event) }))
          }
        }
      }
    }
    let conflicts: readonly FileConflict[] = []
    if (stored !== null && adapter !== null) {
      try {
        conflicts = await this.files(adapter, stored, 'preview').verifyCurrent(stored.files, directionOf(operation))
      } catch (error) {
        if (error instanceof CheckpointFileError) conflicts = error.conflicts
        else throw error
      }
    }
    const markerScope = surface?.operation === 'undo' ? scopeOfMarker(surface.marker) : undefined
    return {
      checkpoint: stored,
      adapter,
      surface,
      preview: {
        sessionId: request.sessionId,
        turn: request.turn,
        ...(operation === 'undo' ? { operation } : {}),
        ...(markerScope === undefined ? {} : { scope: markerScope }),
        messages,
        files: stored?.files.map(file => ({ path: file.path, change: file.change })) ?? [],
        conflicts,
        unavailable: [...new Set(unavailable)],
      },
    }
  }

  private effectiveScope(
    request: CheckpointRollbackRequest,
    evaluation: Evaluation,
  ): CheckpointRollbackScope {
    if (operationOf(request) === 'undo') {
      return evaluation.preview.scope ?? 'conversation-and-files'
    }
    return scopeOf(request)
  }

  private assertExecutable(evaluation: Evaluation, scope: CheckpointRollbackScope): void {
    const unavailable = blockingUnavailable(evaluation.preview.unavailable, scope, {
      trackedFiles: evaluation.preview.files.length,
    })
    if (unavailable.length > 0 || evaluation.surface === null) {
      throw new CheckpointRollbackError('ROLLBACK_UNAVAILABLE',
        unavailable.length > 0 ? unavailable : evaluation.preview.unavailable)
    }
    if (scope === 'conversation-and-files' && evaluation.preview.conflicts.length > 0) {
      throw new CheckpointRollbackError('ROLLBACK_CONFLICT', [], evaluation.preview.conflicts)
    }
  }

  private canCommit(adapter: CheckpointServiceSession, scope: CheckpointRollbackScope): boolean {
    if (!(this.options.isEnabled?.() ?? true)) return false
    // Conversation-only restore does not touch the workspace.
    return scope === 'conversation' || adapter.canRestore
  }

  private files(adapter: CheckpointServiceSession, checkpoint: Checkpoint, journalId: string): CheckpointFiles {
    return new CheckpointFiles({
      workspaceRoot: adapter.workspaceRoot,
      storageRoot: this.options.storageRoot,
      store: this.options.store,
      sessionId: adapter.session.id,
      checkpointId: checkpoint.id,
      createId: () => journalId,
      now: this.options.now,
      operations: this.options.operations,
    })
  }

  private appendOccurred(adapter: CheckpointServiceSession, journalId: string): boolean {
    return adapter.readEvents().some(event => {
      if (isUndoCopyAt(event, undoCopyId(journalId, 0))) return true
      return event.type === 'user/message' && event.data.id.startsWith(ROLLBACK_PREFIX)
        && event.data.id.endsWith(`:${journalId}`)
    })
  }

  private sanitize(error: unknown, signal: AbortSignal): unknown {
    if (signal.aborted) return signal.reason ?? abortError()
    if (error instanceof CheckpointRollbackError) return error
    if (error instanceof CheckpointFileError) {
      return error.code === 'FILE_CONFLICT'
        ? new CheckpointRollbackError('ROLLBACK_CONFLICT', [], error.conflicts)
        : new CheckpointRollbackError('ROLLBACK_FAILED')
    }
    return new CheckpointRollbackError('ROLLBACK_FAILED')
  }
}
