import { randomUUID } from 'node:crypto'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { CheckpointFileError, CheckpointFiles } from './files.ts'
import type { CheckpointFileOperations, FileConflict } from './files.ts'
import type { CheckpointStore } from './store.ts'
import type { Checkpoint, CheckpointJournal } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'checkpoint-rollback': { kind: 'checkpoint-rollback' }
  }
}

const MARKER_PREFIX = 'checkpoint-rollback:'
const surfaceEventTypes = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

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

interface Evaluation {
  readonly checkpoint: Checkpoint | null
  readonly adapter: CheckpointServiceSession | null
  readonly preview: CheckpointRollbackPreview
}

function markerId(journalId: string): MessageId {
  return MessageId(`${MARKER_PREFIX}${journalId}`)
}

function isRollbackMarker(event: SessionEvent): boolean {
  return event.type === 'developer/message'
    && event.data.message.source.kind === 'checkpoint-rollback'
    && event.data.message.content.length === 0
    && event.data.message.id.startsWith(MARKER_PREFIX)
}

function abortError(): DOMException {
  return new DOMException('Checkpoint rollback was cancelled', 'AbortError')
}

function textOf(event: SessionEvent): string {
  if (!surfaceEventTypes.has(event.type)) return ''
  const content = event.type === 'user/message'
    ? event.data.content
    : event.type === 'tool/result' || event.type === 'assistant/message'
      ? event.data.message.content
      : event.type === 'system/message' || event.type === 'developer/message'
        ? event.data.message.content
        : []
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
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
      await this.options.store.recoverInterruptedWrites(request.sessionId)
      await this.recover()
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
          if (current.adapter !== adapter) throw new CheckpointRollbackError('ROLLBACK_UNAVAILABLE', ['session-changed'])
          const checkpoint = current.checkpoint!
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
            const nodes = session.surface.nodes.filter(node => node > checkpoint.atSeq)
            let appended: SessionEvent<'developer/message'>
            try {
              appended = session.append('developer/message', {
                turn: checkpoint.turn,
                step: 0,
                message: {
                  id: markerId(journalId),
                  role: 'developer',
                  content: [],
                  source: { kind: 'checkpoint-rollback' },
                },
              }, nodes.length === 0 ? {
                surfaceOp: 'append',
              } : {
                surfaceOp: {
                  op: 'replace',
                  startSeq: SessionSeq(nodes[0]!),
                  endSeq: SessionSeq(nodes[nodes.length - 1]!),
                },
                sourceEventSeqs: nodes.map(node => SessionSeq(node)),
              })
            } catch {
              return { appended: false, synchronized: false }
            }
            try {
              if (session.deriveEventMessage(appended) !== null) return { appended: true, synchronized: false }
              await adapter.synchronize(maintenance.signal)
              return { appended: true, synchronized: true }
            } catch {
              return { appended: true, synchronized: false }
            }
          })
          return { sessionId: request.sessionId, turn: request.turn, draft: checkpoint.prompt }
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
              if (!this.appendOccurred(adapter, journal)) return false
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

  private async evaluate(request: CheckpointRollbackRequest): Promise<Evaluation> {
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
    if (stored !== null && adapter !== null && stored.atSeq > 0) {
      const events = adapter.readEvents()
      const boundary = events[stored.atSeq + 1]
      if (boundary?.type !== 'turn/start' || boundary.data.turn !== stored.turn
        || events.some((event, index) => event.seq !== index)) {
        unavailable.push('unknown-surface')
      } else {
        if (events.some(event => event.seq > stored.atSeq && typeof event.surfaceOp === 'object'
          && !isRollbackMarker(event))) {
          unavailable.push('compacted-surface')
        }
        const nodes = adapter.session.surface.nodes.filter(node => node > stored.atSeq)
        if (nodes.some(node => events[node] === undefined || !surfaceEventTypes.has(events[node]!.type))) {
          unavailable.push('unknown-surface')
        } else {
          messages = nodes.map(node => ({
            seq: node,
            type: events[node]!.type,
            text: textOf(events[node]!),
          }))
        }
      }
    }
    let conflicts: readonly FileConflict[] = []
    if (stored !== null && adapter !== null) {
      try {
        conflicts = await this.files(adapter, stored, 'preview').verifyCurrent(stored.files)
      } catch (error) {
        if (error instanceof CheckpointFileError) conflicts = error.conflicts
        else throw error
      }
    }
    return {
      checkpoint: stored,
      adapter,
      preview: {
        sessionId: request.sessionId,
        turn: request.turn,
        messages,
        files: stored?.files.map(file => ({ path: file.path, change: file.change })) ?? [],
        conflicts,
        unavailable: [...new Set(unavailable)],
      },
    }
  }

  private assertExecutable(evaluation: Evaluation): void {
    if (evaluation.preview.unavailable.length > 0) {
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

  private appendOccurred(adapter: CheckpointServiceSession, journal: CheckpointJournal): boolean {
    const id = markerId(journal.id)
    return adapter.readEvents().some(event => event.type === 'developer/message' && event.data.message.id === id)
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
