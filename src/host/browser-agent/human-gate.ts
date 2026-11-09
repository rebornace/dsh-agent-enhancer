/** Blocking human-in-the-loop gate (Browser MCP `browser_ask_user` style). */

export interface BrowserHumanRequest {
  readonly id: string
  readonly sessionId: string
  readonly prompt: string
  readonly detail: string
  readonly url?: string
}

type Pending = {
  readonly request: BrowserHumanRequest
  readonly resolve: (status: 'continued' | 'cancelled') => void
  readonly reject: (error: Error) => void
  readonly detachAbort: () => void
}

/**
 * Pauses a tool call until the user finishes login/captcha (or cancels).
 * Unlike soft-pause, the agent turn stays in-flight on the open tool call;
 * when the user continues, the tool returns and the model runs the next step.
 */
export class BrowserHumanGate {
  private readonly pending = new Map<string, Pending>()
  private seq = 0
  private listener: ((request: BrowserHumanRequest | null) => void) | undefined

  setListener(listener: ((request: BrowserHumanRequest | null) => void) | undefined): void {
    this.listener = listener
  }

  current(): BrowserHumanRequest | null {
    const first = this.pending.values().next().value as Pending | undefined
    return first?.request ?? null
  }

  clearSession(sessionId: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.request.sessionId !== sessionId) continue
      this.pending.delete(id)
      entry.detachAbort()
      entry.resolve('cancelled')
    }
    this.emitTop()
  }

  clearAll(): void {
    for (const [, entry] of this.pending) {
      entry.detachAbort()
      entry.resolve('cancelled')
    }
    this.pending.clear()
    this.emitTop()
  }

  /**
   * Block until the user acknowledges (Continue) or the tool abort signal fires.
   */
  async waitForHuman(input: {
    readonly sessionId: string
    readonly prompt: string
    readonly detail: string
    readonly url?: string
    readonly signal: AbortSignal
  }): Promise<'continued' | 'cancelled'> {
    if (input.signal.aborted) return 'cancelled'

    this.seq += 1
    const id = `bh-${this.seq}`
    const request: BrowserHumanRequest = {
      id,
      sessionId: input.sessionId,
      prompt: input.prompt,
      detail: input.detail,
      ...(input.url === undefined ? {} : { url: input.url }),
    }

    return await new Promise<'continued' | 'cancelled'>((resolve, reject) => {
      const onAbort = () => {
        const entry = this.pending.get(id)
        if (entry === undefined) return
        this.pending.delete(id)
        entry.detachAbort()
        reject(new Error('browser human wait aborted'))
        this.emitTop()
      }
      const detachAbort = () => {
        input.signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, {
        request,
        resolve,
        reject,
        detachAbort,
      })
      input.signal.addEventListener('abort', onAbort, { once: true })
      this.emitTop()
    })
  }

  /** Resolve the waiting tool for a session (Continue button). */
  acknowledge(sessionId?: string): boolean {
    const target = typeof sessionId === 'string' && sessionId.trim() !== ''
      ? [...this.pending.values()].find(entry => entry.request.sessionId === sessionId.trim())
      : this.pending.values().next().value as Pending | undefined
    if (target === undefined) return false
    this.pending.delete(target.request.id)
    target.detachAbort()
    target.resolve('continued')
    this.emitTop()
    return true
  }

  private emitTop(): void {
    this.listener?.(this.current())
  }
}
