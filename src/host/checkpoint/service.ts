import { randomUUID } from 'node:crypto'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { CheckpointFileError, CheckpointFiles } from './files.ts'
import type { CheckpointFileOperations, FileConflict, RestoreDirection } from './files.ts'
import type { CheckpointStore } from './store.ts'
import type { Checkpoint } from './types.ts'

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

export type CheckpointUnavailable =
  | 'checkpoint-not-found'
  | 'incomplete-checkpoint'
  | 'prompt-non-text-content'
  | 'workspace-capture-failed'
  | 'session-changed'
  | 'session-running'
  | 'permission-denied'
  | 'rollback-disabled'
  | 'first-turn'
  | 'incompatible-session'
  | 'compacted-surface'
  | 'subagent-session'
  | 'unknown-surface'

export interface CheckpointRollbackRequest {
  readonly sessionId: SessionId
  readonly turn: number
  readonly operation?: CheckpointRollbackOperation
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
}

interface RollbackSurface {
  readonly operation: 'rollback'
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

function rollbackMarkerId(turn: number, journalId: string): MessageId {
  return MessageId(`${ROLLBACK_PREFIX}${turn}:${journalId}`)
}

function undoCopyId(journalId: string, index: number): MessageId {
  return MessageId(`${UNDO_PREFIX}${journalId}:${index}`)
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

function appendUndoCopy(
  session: Session,
  source: SurfaceMessageEvent,
  journalId: string,
  index: number,
  markerSeq: SessionSeq,
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
    case 'assistant/message':
      return session.append('assistant/message', {
        ...source.data,
        message: { ...source.data.message, id },
      }, { surfaceOp: 'append' })
    case 'system/message':
      return session.append('system/message', {
        ...source.data,
        message: { ...source.data.message, id },
      }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
    case 'developer/message':
      return session.append('developer/message', {
        ...source.data,
        message: { ...source.data.message, id },
      }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
    case 'tool/result':
      return session.append('tool/result', {
        ...source.data,
        message: { ...source.data.message, id },
      }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
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
      this.assertExecutable(initial)
      const adapter = initial.adapter!
      return await adapter.runMaintenance(async maintenanceSignal => {
        const maintenance = this.linkedSignal([linked.signal, maintenanceSignal])
        try {
          maintenance.signal.throwIfAborted()
          const current = await this.evaluate(request)
          this.assertExecutable(current)
          if (current.adapter !== adapter || current.surface === null) {
            throw new CheckpointRollbackError('ROLLBACK_UNAVAILABLE', ['session-changed'])
          }
          const checkpoint = current.checkpoint!
          const operation = operationOf(request)
          const session = adapter.session
          const expectedSeq = session.seq
          const expectedNodes = [...session.surface.nodes]
          const journalId = (this.options.createId ?? randomUUID)()
          const files = this.files(adapter, checkpoint, journalId)
          await files.runTransaction(checkpoint.files, async () => {
            if (maintenance.signal.aborted) return { appended: false, synchronized: false }
            const latest = this.options.resolveSession(request.sessionId)
            if (latest !== adapter || !this.stillIdle(adapter) || session.seq !== expectedSeq
              || session.surface.nodes.length !== expectedNodes.length
              || session.surface.nodes.some((node, index) => node !== expectedNodes[index])) {
              return { appended: false, synchronized: false }
            }
            return this.appendAndSynchronize(adapter, current.surface!, journalId, maintenance.signal)
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
    signal: AbortSignal,
  ): Promise<{ appended: boolean, synchronized: boolean }> {
    try {
      if (surface.operation === 'rollback') this.appendRollback(adapter, surface, journalId)
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
  ): void {
    const checkpointTurn = this.turnForMarker(adapter, surface.nodes)
    const summary = `Conversation and tracked files rolled back before turn ${checkpointTurn}`
    adapter.session.append('user/message', {
      id: rollbackMarkerId(checkpointTurn, journalId),
      role: 'user',
      content: [{
        type: 'text',
        text: `The user rolled back the conversation and tracked files to before turn ${checkpointTurn}. `
          + 'Later events remain in the append-only log but are no longer active model context. '
          + 'Re-read tracked files before relying on their contents.',
      }],
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

  private turnForMarker(adapter: CheckpointServiceSession, nodes: readonly SessionSeq[]): number {
    const events = adapter.readEvents()
    const first = nodes[0]!
    for (let seq = Number(first); seq >= 0; seq -= 1) {
      const event = events[seq]
      if (event?.type === 'turn/start') return event.data.turn
    }
    throw new Error('Rollback surface has no owning turn')
  }

  private appendUndo(
    session: Session,
    marker: SessionEvent<'user/message'>,
    sources: readonly SurfaceMessageEvent[],
    journalId: string,
    start = 0,
  ): void {
    for (let index = start; index < sources.length; index += 1) {
      appendUndoCopy(session, sources[index]!, journalId, index, marker.seq)
    }
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
    let completed = 0
    while (events.some(event => isUndoCopyAt(event, undoCopyId(journalId, completed)))) completed += 1
    for (let index = 0; index < completed; index += 1) {
      if (!isUndoCopyAt(events[SessionSeq(first.seq + index)]!, undoCopyId(journalId, index))) {
        throw new CheckpointRollbackError('ROLLBACK_RECOVERY_FAILED')
      }
    }
    if (Number(adapter.session.seq) - 1 !== first.seq + completed - 1) {
      throw new CheckpointRollbackError('ROLLBACK_RECOVERY_FAILED')
    }
    this.appendUndo(adapter.session, marker, sources, journalId, completed)
  }

  private async evaluate(request: CheckpointRollbackRequest): Promise<Evaluation> {
    const operation = operationOf(request)
    const checkpoints = await this.options.store.list(request.sessionId)
    const stored = checkpoints.find(checkpoint => checkpoint.turn === request.turn) ?? null
    const adapter = this.options.resolveSession(request.sessionId) ?? null
    const unavailable: CheckpointUnavailable[] = []
    if (stored === null) unavailable.push('checkpoint-not-found')
    if (adapter === null) unavailable.push('session-changed')
    if (this.options.isEnabled !== undefined && !this.options.isEnabled()) unavailable.push('rollback-disabled')
    if (adapter !== null) {
      if (adapter.status !== 'idle') unavailable.push('session-running')
      if (!adapter.canRestore) unavailable.push('permission-denied')
      if (adapter.session.header.origin === 'subagent' || (adapter.session.header.delegationDepth ?? 0) > 0) {
        unavailable.push('subagent-session')
      }
    }
    if (stored !== null) {
      if (stored.atSeq <= 0) unavailable.push('first-turn')
      if (stored.coverage !== 'complete' || stored.gaps.length > 0) unavailable.push('incomplete-checkpoint')
      for (const gap of stored.gaps) {
        unavailable.push(gap.type === 'prompt' ? 'prompt-non-text-content' : 'workspace-capture-failed')
      }
      if (adapter !== null && (stored.session.format !== adapter.session.header.version
        || stored.session.preset !== (adapter.session.header.agentPreset ?? null)
        || stored.pluginVersion !== this.options.pluginVersion)) {
        unavailable.push('incompatible-session')
      }
    }
    let messages: CheckpointMessagePreview[] = []
    let surface: RollbackSurface | UndoSurface | null = null
    if (stored !== null && adapter !== null && stored.atSeq > 0) {
      const events = adapter.readEvents()
      const boundary = events[stored.atSeq + 1]
      if (boundary?.type !== 'turn/start' || boundary.data.turn !== stored.turn
        || events.some((event, index) => event.seq !== index)) {
        unavailable.push('unknown-surface')
      } else if (operation === 'rollback') {
        if (events.some(event => event.seq > stored.atSeq && typeof event.surfaceOp === 'object'
          && !isOwnReplacement(event))) {
          unavailable.push('compacted-surface')
        }
        const nodes = adapter.session.surface.nodes.filter(node => logicalSeq(events[node]!) > stored.atSeq)
        const first = nodes.length === 0 ? undefined : events[nodes[0]!]
        if (nodes.length === 0 || first?.type !== 'user/message'
          || nodes.some(node => events[node] === undefined || !surfaceEventTypes.has(events[node]!.type))) {
          unavailable.push('unknown-surface')
        } else {
          const typedNodes = nodes.map(node => SessionSeq(node))
          surface = { operation, nodes: typedNodes }
          messages = typedNodes.map(node => ({
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
          || currentNodes.slice(0, -1).some(node => logicalSeq(events[node]!) > stored.atSeq)
          || events.slice(Number(origin.seq) + 1).some(event => !isRollbackMarker(event) && !isUndoCopy(event))) {
          unavailable.push('session-changed')
        } else {
          const sources = sourceEvents(events, marker)
          if (sources === null || sources.some(event => event.seq <= stored.atSeq)) {
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
    return {
      checkpoint: stored,
      adapter,
      surface,
      preview: {
        sessionId: request.sessionId,
        turn: request.turn,
        ...(operation === 'undo' ? { operation } : {}),
        messages,
        files: stored?.files.map(file => ({ path: file.path, change: file.change })) ?? [],
        conflicts,
        unavailable: [...new Set(unavailable)],
      },
    }
  }

  private assertExecutable(evaluation: Evaluation): void {
    if (evaluation.preview.unavailable.length > 0 || evaluation.surface === null) {
      throw new CheckpointRollbackError('ROLLBACK_UNAVAILABLE', evaluation.preview.unavailable)
    }
    if (evaluation.preview.conflicts.length > 0) {
      throw new CheckpointRollbackError('ROLLBACK_CONFLICT', [], evaluation.preview.conflicts)
    }
  }

  private stillIdle(adapter: CheckpointServiceSession): boolean {
    return adapter.status === 'idle' && adapter.canRestore
      && (this.options.isEnabled?.() ?? true)
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
