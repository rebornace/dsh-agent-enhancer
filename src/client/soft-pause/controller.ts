import type { SessionId } from '@deepseek-ai/dsh-session/types'

export interface SoftPauseRemote {
  snapshot(sessionId: SessionId, signal?: AbortSignal): Promise<{ readonly engaged: boolean }>
  set(
    sessionId: SessionId,
    engaged: boolean,
    signal?: AbortSignal,
  ): Promise<{ readonly engaged: boolean }>
}

export interface SoftPauseSnapshot {
  readonly enabled: boolean
  readonly engaged: boolean
  readonly busy: boolean
}

export interface SoftPauseControllerOptions {
  readonly sessionId: SessionId
  readonly enabled: () => boolean
  readonly remote: SoftPauseRemote
  readonly pollMs?: number
}

const DEFAULT_POLL_MS = 750

export class SoftPauseController {
  private readonly listeners = new Set<() => void>()
  private snapshot: SoftPauseSnapshot
  private disposed = false
  private timer: ReturnType<typeof setInterval> | null = null
  private refreshController: AbortController | null = null

  constructor(private readonly options: SoftPauseControllerOptions) {
    this.snapshot = { enabled: options.enabled(), engaged: false, busy: false }
    if (this.snapshot.enabled) {
      this.startPolling()
      void this.refresh()
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): SoftPauseSnapshot => this.snapshot

  refreshSettings(): void {
    if (this.disposed) return
    const enabled = this.options.enabled()
    if (!enabled) {
      this.stopPolling()
      if (this.snapshot.engaged || this.snapshot.enabled) {
        this.snapshot = { enabled: false, engaged: false, busy: false }
        this.emit()
      }
      return
    }
    if (!this.snapshot.enabled) {
      this.snapshot = { ...this.snapshot, enabled: true }
      this.emit()
      this.startPolling()
      void this.refresh()
      return
    }
    this.startPolling()
  }

  async toggle(): Promise<void> {
    if (this.disposed || this.snapshot.busy || !this.snapshot.enabled) return
    const next = !this.snapshot.engaged
    this.snapshot = { ...this.snapshot, busy: true }
    this.emit()
    try {
      const result = await this.options.remote.set(this.options.sessionId, next)
      if (this.disposed) return
      this.snapshot = { enabled: true, engaged: result.engaged, busy: false }
      this.emit()
    } catch {
      if (this.disposed) return
      this.snapshot = { ...this.snapshot, busy: false }
      this.emit()
      void this.refresh()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopPolling()
    this.refreshController?.abort()
    this.refreshController = null
    this.listeners.clear()
  }

  private async refresh(): Promise<void> {
    if (this.disposed || !this.options.enabled()) return
    this.refreshController?.abort()
    const controller = new AbortController()
    this.refreshController = controller
    try {
      const result = await this.options.remote.snapshot(
        this.options.sessionId,
        controller.signal,
      )
      if (this.disposed || controller.signal.aborted) return
      if (this.snapshot.engaged === result.engaged && this.snapshot.enabled) return
      this.snapshot = {
        enabled: true,
        engaged: result.engaged,
        busy: this.snapshot.busy,
      }
      this.emit()
    } catch {
      // Keep last known state; next poll retries.
    }
  }

  private startPolling(): void {
    if (this.timer !== null || this.disposed) return
    const ms = this.options.pollMs ?? DEFAULT_POLL_MS
    this.timer = setInterval(() => { void this.refresh() }, ms)
  }

  private stopPolling(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
