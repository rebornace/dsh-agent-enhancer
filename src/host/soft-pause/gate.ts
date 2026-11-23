/** In-memory soft-pause gate: hold `agent/pre-step` until release or abort. */

type Waiter = {
  /** One of its buckets was flushed: re-check whether anything is still engaged. */
  readonly wake: () => void
}

export interface WaitWhileEngagedOptions {
  /**
   * Session whose own pause a signal abort drops. A stopped turn has always
   * cleared its pause; a subagent step must not clear an ancestor's pause.
   */
  readonly clearOnAbort?: string
}

export class SoftPauseGate {
  private readonly engaged = new Set<string>()
  private readonly waiters = new Map<string, Set<Waiter>>()

  isEngaged(sessionId: string): boolean {
    return this.engaged.has(sessionId)
  }

  engage(sessionId: string): void {
    this.engaged.add(sessionId)
  }

  /** Clear engaged and let every waiter proceed (resume). */
  release(sessionId: string): void {
    this.engaged.delete(sessionId)
    this.flushWaiters(sessionId)
  }

  /**
   * When the session is engaged, wait until `release` or `signal` abort.
   * Abort clears engaged for that session. Always settles (never throws) so
   * callers can check `signal.aborted` and return `{ kind: 'reject' }`.
   */
  async waitIfEngaged(sessionId: string, signal: AbortSignal): Promise<void> {
    await this.waitWhileEngaged([sessionId], signal, { clearOnAbort: sessionId })
  }

  /**
   * Wait while ANY of `sessionIds` is engaged, settling only when none is.
   * A subagent step passes its own id plus its engaged subagent ancestors, so
   * releasing one of them cannot let the step through while another holds it.
   */
  async waitWhileEngaged(
    sessionIds: readonly string[],
    signal: AbortSignal,
    options: WaitWhileEngagedOptions = {},
  ): Promise<void> {
    const owners = [...new Set(sessionIds)]
    if (!owners.some(id => this.engaged.has(id))) return
    if (signal.aborted) {
      if (options.clearOnAbort !== undefined) this.clear(options.clearOnAbort)
      return
    }
    await new Promise<void>(resolve => {
      let settled = false
      let registered: string[] = []
      let waiter: Waiter

      const detach = () => {
        signal.removeEventListener('abort', onAbort)
      }
      const settle = () => {
        if (settled) return
        settled = true
        detach()
        for (const id of registered) {
          const bucket = this.waiters.get(id)
          if (bucket === undefined) continue
          bucket.delete(waiter)
          if (bucket.size === 0) this.waiters.delete(id)
        }
        registered = []
        resolve()
      }
      const register = () => {
        registered = []
        for (const id of owners) {
          if (!this.engaged.has(id)) continue
          let bucket = this.waiters.get(id)
          if (bucket === undefined) {
            bucket = new Set()
            this.waiters.set(id, bucket)
          }
          bucket.add(waiter)
          registered.push(id)
        }
      }
      const onAbort = () => {
        if (options.clearOnAbort !== undefined) this.clear(options.clearOnAbort)
        settle()
      }
      const wake = () => {
        if (settled) return
        if (owners.some(id => this.engaged.has(id))) register()
        else settle()
      }

      waiter = { wake }
      register()
      signal.addEventListener('abort', onAbort, { once: true })
      // Engage may have been released between the check and registration.
      if (signal.aborted) onAbort()
      else if (!owners.some(id => this.engaged.has(id))) settle()
    })
  }

  /** Drop engaged + waiters without distinguishing resume vs abort. */
  clear(sessionId: string): void {
    this.engaged.delete(sessionId)
    this.flushWaiters(sessionId)
  }

  private flushWaiters(sessionId: string): void {
    const bucket = this.waiters.get(sessionId)
    if (bucket === undefined) return
    this.waiters.delete(sessionId)
    for (const waiter of bucket) waiter.wake()
  }
}
