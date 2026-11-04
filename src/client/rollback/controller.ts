import type {
  CheckpointRollbackErrorCode,
  CheckpointRollbackOperation,
  CheckpointRollbackPreview,
  CheckpointRollbackRequest,
  CheckpointRollbackResult,
  CheckpointRollbackScope,
  CheckpointTurnSummary,
} from '../../host/checkpoint/service.ts'
import { rollbackErrorCodeOf } from './failure.ts'
import { confirmBlocked, scopeLabel } from './scope.ts'
import type {
  RollbackActive,
  RollbackControllerOptions,
  RollbackDraftActions,
  RollbackModalSurface,
  RollbackRemote,
  RollbackSnapshot,
} from './types.ts'

export type { RollbackRemote } from './types.ts'

interface Operation extends RollbackActive {
  readonly controller: AbortController
}

export class RollbackController {
  private readonly listeners = new Set<() => void>()
  private readonly surfaces = new Set<RollbackModalSurface>()
  private operation: Operation | null = null
  private coverageByTurn: Readonly<Record<number, CheckpointTurnSummary>> = {}
  private coverageController: AbortController | null = null
  private snapshot: RollbackSnapshot
  private version = 0
  private disposed = false
  /** Last agent running bit from the composer overlay; drives stale-modal refresh. */
  private lastKnownRunning: boolean | undefined

  constructor(private readonly options: RollbackControllerOptions) {
    this.snapshot = { enabled: options.enabled(), active: null, coverageByTurn: {} }
    if (options.enabled()) this.refreshCoverage()
  }

  /**
   * Modal hosts register so `open` can fall back to any mounted surface — a
   * timeline click must never leave `active` with no host willing to render it.
   */
  registerSurface(surface: RollbackModalSurface): () => void {
    this.surfaces.add(surface)
    return () => { this.surfaces.delete(surface) }
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
      this.clearCoverage()
      this.publish()
      return
    }
    if (this.snapshot.enabled) return
    this.publish()
    this.refreshCoverage()
  }

  /**
   * Refresh an open ready/error modal when the session run cycle flips
   * (running→idle clears session-running / recovery waits; idle→running refreshes gates).
   */
  notifySessionRunning(running: boolean): void {
    if (this.disposed) return
    const previous = this.lastKnownRunning
    this.lastKnownRunning = running
    if (!this.options.enabled() || previous === undefined || previous === running) return
    const active = this.operation
    if (active === null || active.status === 'executing' || active.status === 'loading') return
    this.open(active.turn, active.operation, { surface: active.surface })
  }

  open(
    turn: number,
    operation: CheckpointRollbackOperation = 'rollback',
    options: { readonly surface?: RollbackModalSurface } = {},
  ): void {
    if (this.disposed || !this.options.enabled() || this.operation?.status === 'executing') return
    this.cancelOperation()
    const version = ++this.version
    const controller = new AbortController()
    const surface = this.resolveSurface(options.surface ?? 'composer')
    this.operation = { turn, operation, status: 'loading', version, controller, surface }
    this.publish()
    const request: CheckpointRollbackRequest = { sessionId: this.options.sessionId, turn, operation }
    void this.options.remote.preview(request, controller.signal).then(result => {
      if (!this.current(version, request, result)) return
      this.rememberPreviewCoverage(result)
      // Undo remaps browsed cards onto the live tip — keep operation.turn in sync.
      this.operation = {
        ...this.operation!,
        turn: result.turn,
        status: 'ready',
        preview: result,
      }
      this.publish()
    }).catch((error: unknown) => {
      if (!this.current(version, request)) return
      this.operation = {
        ...this.operation!,
        status: 'error',
        error: 'preview',
        ...errorFields(error),
      }
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
    this.operation = {
      ...active,
      status: 'executing',
      scope: effectiveScope,
      controller,
      surface: active.surface,
    }
    this.publish()
    let result: CheckpointRollbackResult
    try {
      result = await this.options.remote.execute(request, controller.signal)
    } catch (error) {
      if (this.disposed || !this.options.enabled()) return
      // Never fail silently: even if close/abort raced, reopen an error state.
      if ((controller.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
        && !this.options.enabled()) return
      this.failExecute(turn, operation, preview, effectiveScope, error)
      return
    }
    if (this.disposed || !this.options.enabled()) return
    if (result === null || typeof result !== 'object'
      || result.sessionId !== request.sessionId || result.turn !== request.turn
      || typeof result.draft !== 'string') {
      this.failExecute(turn, operation, preview, effectiveScope)
      return
    }
    try {
      // Prefill is rollback's own composer write — not prompt-history navigation.
      actions.setDraft(result.draft)
      actions.persistDraft()
    } catch {
      this.failExecute(turn, operation, preview, effectiveScope)
      return
    }
    this.operation = null
    this.publish()
    this.refreshCoverage()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelOperation()
    this.clearCoverage()
    this.listeners.clear()
  }

  private refreshCoverage(): void {
    const summaries = this.options.remote.summaries
    if (summaries === undefined || this.disposed || !this.options.enabled()) return
    this.coverageController?.abort()
    const controller = new AbortController()
    this.coverageController = controller
    void summaries({ sessionId: this.options.sessionId }, controller.signal).then(result => {
      if (this.disposed || controller.signal.aborted || !this.options.enabled()) return
      if (result.sessionId !== this.options.sessionId) return
      const next: Record<number, CheckpointTurnSummary> = {}
      for (const turn of result.turns) next[turn.turn] = turn
      this.coverageByTurn = next
      this.publish()
    }).catch(() => {
      // Coverage is an affordance only — leave the last known map in place.
    })
  }

  private rememberPreviewCoverage(preview: CheckpointRollbackPreview): void {
    if (preview.operation === 'undo') return
    const incomplete = preview.unavailable.includes('incomplete-checkpoint')
      || preview.unavailable.includes('workspace-capture-failed')
    const previous = this.coverageByTurn[preview.turn]
    this.coverageByTurn = {
      ...this.coverageByTurn,
      [preview.turn]: {
        turn: preview.turn,
        coverage: incomplete ? 'partial' : 'complete',
        fileCount: preview.files.length,
        createdAt: previous?.createdAt ?? Date.now(),
        atSeq: previous?.atSeq ?? 0,
        prompt: previous?.prompt ?? '',
        promptPreview: previous?.promptPreview ?? '',
        files: preview.files.map(file => ({ path: file.path, change: file.change })),
        gaps: previous?.gaps ?? [],
        rolledBack: previous?.rolledBack ?? false,
        tip: previous?.tip ?? false,
      },
    }
  }

  private clearCoverage(): void {
    this.coverageController?.abort()
    this.coverageController = null
    this.coverageByTurn = {}
  }

  private resolveSurface(preferred: RollbackModalSurface): RollbackModalSurface {
    if (this.surfaces.has(preferred)) return preferred
    if (this.surfaces.has('composer')) return 'composer'
    if (this.surfaces.has('timeline')) return 'timeline'
    return preferred
  }

  private current(
    version: number,
    request: CheckpointRollbackRequest,
    response?: CheckpointRollbackPreview | CheckpointRollbackResult,
  ): boolean {
    const operation = request.operation ?? 'rollback'
    if (this.disposed || !this.options.enabled() || this.version !== version) return false
    if (this.operation?.version !== version || this.operation.operation !== operation) return false
    // While loading, operation.turn still matches the open request. After undo
    // remaps, operation.turn may already equal preview.turn (≠ request.turn).
    if (response === undefined) {
      return this.operation.turn === request.turn || operation === 'undo'
    }
    if (response.sessionId !== request.sessionId) return false
    // Undo remaps later rolled-back cards onto the live tip — accept tip turn.
    if (operation === 'undo') return true
    return response.turn === request.turn
  }

  private failExecute(
    turn: number,
    operation: CheckpointRollbackOperation,
    preview: CheckpointRollbackPreview,
    scope: CheckpointRollbackScope,
    error?: unknown,
  ): void {
    this.operation = {
      turn,
      operation,
      status: 'error',
      error: 'execute',
      version: this.version,
      controller: new AbortController(),
      preview,
      scope,
      surface: this.operation?.surface ?? 'composer',
      ...errorFields(error),
    }
    this.publish()
  }

  private cancelOperation(): void {
    this.version += 1
    this.operation?.controller.abort()
    this.operation = null
  }

  private publish(): void {
    this.snapshot = {
      enabled: !this.disposed && this.options.enabled(),
      coverageByTurn: this.coverageByTurn,
      active: this.operation === null ? null : {
        turn: this.operation.turn,
        operation: this.operation.operation,
        status: this.operation.status,
        version: this.operation.version,
        surface: this.operation.surface,
        ...(this.operation.preview === undefined ? {} : { preview: this.operation.preview }),
        ...(this.operation.scope === undefined ? {} : { scope: this.operation.scope }),
        ...(this.operation.error === undefined ? {} : { error: this.operation.error }),
        ...(this.operation.errorCode === undefined ? {} : { errorCode: this.operation.errorCode }),
      },
    }
    for (const listener of this.listeners) listener()
  }
}

function errorFields(error: unknown): { readonly errorCode?: CheckpointRollbackErrorCode } {
  const errorCode = rollbackErrorCodeOf(error)
  return errorCode === undefined ? {} : { errorCode }
}
