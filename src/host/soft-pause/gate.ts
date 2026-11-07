/** In-memory soft-pause gate: hold `agent/pre-step` until release or abort. */

type Waiter = {
  readonly settle: () => void
  readonly detachAbort: () => void
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
    if (!this.engaged.has(sessionId)) return
    if (signal.aborted) {
      this.clear(sessionId)
      return
    }
    await new Promise<void>(resolve => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        detachAbort()
        const bucket = this.waiters.get(sessionId)
        if (bucket !== undefined) {
          bucket.delete(waiter)
          if (bucket.size === 0) this.waiters.delete(sessionId)
        }
        resolve()
      }
      const onAbort = () => {
        this.engaged.delete(sessionId)
        this.flushWaiters(sessionId)
      }
      const detachAbort = () => {
        signal.removeEventListener('abort', onAbort)
      }
      const waiter: Waiter = { settle, detachAbort }
      let bucket = this.waiters.get(sessionId)
      if (bucket === undefined) {
        bucket = new Set()
        this.waiters.set(sessionId, bucket)
      }
      bucket.add(waiter)
      signal.addEventListener('abort', onAbort, { once: true })
      // Engage may have been released between the check and registration.
      if (!this.engaged.has(sessionId) || signal.aborted) {
        if (signal.aborted) this.engaged.delete(sessionId)
        settle()
      }
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
    for (const waiter of bucket) {
      waiter.detachAbort()
      waiter.settle()
    }
  }
}
