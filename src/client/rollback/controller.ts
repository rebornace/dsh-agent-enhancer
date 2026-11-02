import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CheckpointRollbackOperation,
  CheckpointRollbackPreview,
  CheckpointRollbackRequest,
  CheckpointRollbackResult,
  CheckpointRollbackScope,
} from '../../host/checkpoint/service.ts'
import { confirmBlocked, scopeLabel } from './scope.ts'
import type {
  RollbackActive,
  RollbackControllerOptions,
  RollbackDraftActions,
  RollbackRemote,
  RollbackSnapshot,
} from './types.ts'

export type { RollbackRemote } from './types.ts'

interface Operation extends RollbackActive {
  readonly controller: AbortController
}

export class RollbackController {
  private readonly listeners = new Set<() => void>()
  private operation: Operation | null = null
  private snapshot: RollbackSnapshot
  private version = 0
  private disposed = false

  constructor(private readonly options: RollbackControllerOptions) {
    this.snapshot = { enabled: options.enabled(), active: null }
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): RollbackSnapshot => this.snapshot

  refreshSettings(): void {
    if (this.disposed) return
    const enabled = this.options.enabled()
    if (!enabled) {
      this.cancelOperation()
      this.publish()
      return
    }
    if (this.snapshot.enabled) return
    this.publish()
  }

  open(turn: number, operation: CheckpointRollbackOperation = 'rollback'): void {
    if (this.disposed || !this.options.enabled() || this.operation?.status === 'executing') return
    this.cancelOperation()
    const version = ++this.version
    const controller = new AbortController()
    this.operation = { turn, operation, status: 'loading', version, controller }
    this.publish()
    const request: CheckpointRollbackRequest = { sessionId: this.options.sessionId, turn, operation }
    void this.options.remote.preview(request, controller.signal).then(result => {
      if (!this.current(version, request, result)) return
      this.operation = { ...this.operation!, status: 'ready', preview: result }
      this.publish()
    }).catch(() => {
      if (!this.current(version, request)) return
      this.operation = { ...this.operation!, status: 'error', error: 'preview' }
      this.publish()
    })
  }

  close(turn?: number): void {
    if (this.disposed || (turn !== undefined && this.operation?.turn !== turn)) return
    // Never abort an in-flight restore: surface replacement can unmount entry UI mid-flight.
    if (this.operation?.status === 'executing') return
    this.cancelOperation()
    this.publish()
  }

  async confirm(
    actions: RollbackDraftActions,
    scope: CheckpointRollbackScope = 'conversation-and-files',
  ): Promise<void> {
    const active = this.operation
    if (this.disposed || active?.status !== 'ready' || active.preview === undefined) return
    const effectiveScope = active.operation === 'undo'
      ? scopeLabel(active.preview.scope)
      : scope
    if (confirmBlocked(
      active.preview.unavailable,
      active.preview.conflicts,
      effectiveScope,
      active.preview.files.length,
    )) return
    const { turn, operation } = active
    const preview = active.preview
    const request: CheckpointRollbackRequest = {
      sessionId: this.options.sessionId,
      turn,
      operation,
      scope: effectiveScope,
    }
    const controller = new AbortController()
    this.operation = { ...active, status: 'executing', scope: effectiveScope, controller }
    this.publish()
    let result: CheckpointRollbackResult
    try {
      result = await this.options.remote.execute(request, controller.signal)
    } catch (error) {
      if (this.disposed || !this.options.enabled()) return
      // Never fail silently: even if close/abort raced, reopen an error state.
      if ((controller.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
        && !this.options.enabled()) return
      this.operation = {
        turn,
        operation,
        status: 'error',
        error: 'execute',
        version: this.version,
        controller: new AbortController(),
        preview,
        scope: effectiveScope,
      }
      this.publish()
      return
    }
    if (this.disposed || !this.options.enabled()) return
    if (result === null || typeof result !== 'object'
      || result.sessionId !== request.sessionId || result.turn !== request.turn
      || typeof result.draft !== 'string') {
      this.operation = {
        turn,
        operation,
        status: 'error',
        error: 'execute',
        version: this.version,
        controller: new AbortController(),
        preview,
        scope: effectiveScope,
      }
      this.publish()
      return
    }
    try {
      actions.setDraft(result.draft)
      actions.persistDraft()
    } catch {
      this.operation = {
        turn,
        operation,
        status: 'error',
        error: 'execute',
        version: this.version,
        controller: new AbortController(),
        preview,
        scope: effectiveScope,
      }
      this.publish()
      return
    }
    this.operation = null
    this.publish()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelOperation()
    this.listeners.clear()
  }

  private current(
    version: number,
    request: CheckpointRollbackRequest,
    response?: CheckpointRollbackPreview | CheckpointRollbackResult,
  ): boolean {
    const operation = request.operation ?? 'rollback'
    return !this.disposed && this.options.enabled() && this.version === version
      && this.operation?.version === version && this.operation.turn === request.turn
      && this.operation.operation === operation
      && (response === undefined || (response.sessionId === request.sessionId && response.turn === request.turn))
  }

  private cancelOperation(): void {
    this.version += 1
    this.operation?.controller.abort()
    this.operation = null
  }

  private publish(): void {
    this.snapshot = {
      enabled: !this.disposed && this.options.enabled(),
      active: this.operation === null ? null : {
        turn: this.operation.turn,
        operation: this.operation.operation,
        status: this.operation.status,
        version: this.operation.version,
        ...(this.operation.preview === undefined ? {} : { preview: this.operation.preview }),
        ...(this.operation.scope === undefined ? {} : { scope: this.operation.scope }),
        ...(this.operation.error === undefined ? {} : { error: this.operation.error }),
      },
    }
    for (const listener of this.listeners) listener()
  }
}
