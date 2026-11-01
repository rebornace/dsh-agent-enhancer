import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CheckpointRollbackPreview,
  CheckpointRollbackRequest,
  CheckpointRollbackResult,
} from '../../host/checkpoint/service.ts'
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
      this.close()
      return
    }
    if (this.snapshot.enabled) return
    this.publish()
  }

  open(turn: number): void {
    if (this.disposed || !this.options.enabled() || this.operation?.status === 'executing') return
    this.cancelOperation()
    const version = ++this.version
    const controller = new AbortController()
    this.operation = { turn, status: 'loading', version, controller }
    this.publish()
    const request: CheckpointRollbackRequest = { sessionId: this.options.sessionId, turn }
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
    this.cancelOperation()
    this.publish()
  }

  async confirm(actions: RollbackDraftActions): Promise<void> {
    const active = this.operation
    if (this.disposed || active?.status !== 'ready' || active.preview === undefined
      || active.preview.unavailable.length > 0 || active.preview.conflicts.length > 0) return
    const { turn, version } = active
    const request: CheckpointRollbackRequest = { sessionId: this.options.sessionId, turn }
    const controller = new AbortController()
    this.operation = { ...active, status: 'executing', controller }
    this.publish()
    let result: CheckpointRollbackResult
    try {
      result = await this.options.remote.execute(request, controller.signal)
    } catch {
      if (this.current(version, request)) {
        this.operation = { ...this.operation!, status: 'error', error: 'execute' }
        this.publish()
      }
      return
    }
    if (!this.current(version, request, result)) return
    actions.setDraft(result.draft)
    actions.persistDraft()
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
    return !this.disposed && this.options.enabled() && this.version === version
      && this.operation?.version === version && this.operation.turn === request.turn
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
        status: this.operation.status,
        version: this.operation.version,
        ...(this.operation.preview === undefined ? {} : { preview: this.operation.preview }),
        ...(this.operation.error === undefined ? {} : { error: this.operation.error }),
      },
    }
    for (const listener of this.listeners) listener()
  }
}
