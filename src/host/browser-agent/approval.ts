import { originOfUrl } from './protocol.ts'

export type BrowserApprovalDecision = 'allow-once' | 'allow-origin' | 'deny'

export interface BrowserApprovalRequest {
  readonly id: string
  readonly sessionId: string
  readonly tool: string
  readonly summary: string
  readonly url?: string
  readonly origin?: string
  /** JPEG crop of the control under discussion, for the card to show. */
  readonly thumbnail?: { readonly mime: string; readonly base64: string }
}

/** A time- and action-bounded grant for one session+origin (unattended flow runs). */
export interface BrowserOriginGrant {
  readonly sessionId: string
  readonly origin: string
  readonly expiresAt: number
  /** How many mutating calls it still covers. */
  remaining: number
}

type Pending = {
  readonly request: BrowserApprovalRequest
  readonly resolve: (decision: BrowserApprovalDecision) => void
  readonly reject: (error: Error) => void
  readonly detachAbort: () => void
}

/** In-memory approval gate for mutating browser tools (dialog-driven only). */
export class BrowserApprovalGate {
  private readonly pending = new Map<string, Pending>()
  private readonly allowedOrigins = new Map<string, Set<string>>()
  private readonly grants = new Map<string, BrowserOriginGrant>()
  private seq = 0
  private listener: ((request: BrowserApprovalRequest | null) => void) | undefined

  setListener(listener: ((request: BrowserApprovalRequest | null) => void) | undefined): void {
    this.listener = listener
  }

  allowedOriginList(sessionId?: string): readonly string[] {
    if (sessionId !== undefined) {
      return [...(this.allowedOrigins.get(sessionId) ?? [])]
    }
    const all = new Set<string>()
    for (const set of this.allowedOrigins.values()) {
      for (const origin of set) all.add(origin)
    }
    return [...all]
  }

  /**
   * Allow mutations on one origin for a while, without a card. Used when the
   * user marked a saved flow "允许无人值守运行": the grant covers that run and
   * the repairs it needs, then expires on time or after N actions.
   */
  grantOrigin(input: {
    readonly sessionId: string
    readonly url: string
    readonly ttlMs: number
    readonly actions: number
  }): boolean {
    const origin = originOfUrl(input.url)
    if (origin === undefined || input.actions <= 0 || input.ttlMs <= 0) return false
    this.grants.set(this.grantKey(input.sessionId, origin), {
      sessionId: input.sessionId,
      origin,
      expiresAt: Date.now() + input.ttlMs,
      remaining: input.actions,
    })
    return true
  }

  /** Active grants, for the panel and for tests. */
  activeGrants(): readonly BrowserOriginGrant[] {
    this.pruneGrants()
    return [...this.grants.values()]
  }

  clearSession(sessionId: string): void {
    this.allowedOrigins.delete(sessionId)
    for (const [key, grant] of [...this.grants]) {
      if (grant.sessionId === sessionId) this.grants.delete(key)
    }
    for (const [id, entry] of [...this.pending]) {
      if (entry.request.sessionId !== sessionId) continue
      this.pending.delete(id)
      entry.detachAbort()
      entry.reject(new Error('browser approval cancelled: session cleared'))
    }
    this.emitTop()
  }

  clearAll(): void {
    this.allowedOrigins.clear()
    for (const [, entry] of this.pending) {
      entry.detachAbort()
      entry.reject(new Error('browser approval cancelled'))
    }
    this.pending.clear()
    this.emitTop()
  }

  current(): BrowserApprovalRequest | null {
    const first = this.pending.values().next().value as Pending | undefined
    return first?.request ?? null
  }

  /** Crop for one pending approval, or null when it is gone or had none. */
  thumbnailFor(id: string): { readonly mime: string; readonly base64: string } | null {
    return this.pending.get(id)?.request.thumbnail ?? null
  }

  /**
   * Returns true when the action may proceed without prompting.
   * Read-only tools should skip this gate entirely.
   */
  isPreauthorized(sessionId: string, url: string | undefined): boolean {
    const origin = url === undefined ? undefined : originOfUrl(url)
    if (origin === undefined) return false
    if (this.allowedOrigins.get(sessionId)?.has(origin) === true) return true
    const key = this.grantKey(sessionId, origin)
    const grant = this.grants.get(key)
    if (grant === undefined) return false
    if (grant.expiresAt <= Date.now() || grant.remaining <= 0) {
      this.grants.delete(key)
      return false
    }
    grant.remaining -= 1
    if (grant.remaining <= 0) this.grants.delete(key)
    return true
  }

  private grantKey(sessionId: string, origin: string): string {
    return sessionId + '\u0000' + origin
  }

  private pruneGrants(): void {
    const now = Date.now()
    for (const [key, grant] of [...this.grants]) {
      if (grant.expiresAt <= now || grant.remaining <= 0) this.grants.delete(key)
    }
  }

  async requestApproval(input: {
    readonly sessionId: string
    readonly tool: string
    readonly summary: string
    readonly url?: string
    readonly signal: AbortSignal
    /** When true, skip session-origin short-circuit (e.g. Alt+click while disconnected). */
    readonly forcePrompt?: boolean
    /** Crop of the control, captured before the card appears. */
    readonly thumbnail?: { readonly mime: string; readonly base64: string }
  }): Promise<'allow' | 'deny'> {
    if (!input.forcePrompt && this.isPreauthorized(input.sessionId, input.url)) return 'allow'
    if (input.signal.aborted) return 'deny'

    this.seq += 1
    const id = `ba-${this.seq}`
    const origin = input.url === undefined ? undefined : originOfUrl(input.url)
    const request: BrowserApprovalRequest = {
      id,
      sessionId: input.sessionId,
      tool: input.tool,
      summary: input.summary,
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(origin === undefined ? {} : { origin }),
      ...(input.thumbnail === undefined ? {} : { thumbnail: input.thumbnail }),
    }

    const decision = await new Promise<BrowserApprovalDecision>((resolve, reject) => {
      const onAbort = () => {
        const entry = this.pending.get(id)
        if (entry === undefined) return
        this.pending.delete(id)
        entry.detachAbort()
        reject(new Error('browser approval aborted'))
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

    if (decision === 'deny') return 'deny'
    if (decision === 'allow-origin' && origin !== undefined) {
      let set = this.allowedOrigins.get(input.sessionId)
      if (set === undefined) {
        set = new Set()
        this.allowedOrigins.set(input.sessionId, set)
      }
      set.add(origin)
    }
    return 'allow'
  }

  resolve(id: string, decision: BrowserApprovalDecision): boolean {
    const entry = this.pending.get(id)
    if (entry === undefined) return false
    this.pending.delete(id)
    entry.detachAbort()
    entry.resolve(decision)
    this.emitTop()
    return true
  }

  private emitTop(): void {
    this.listener?.(this.current())
  }
}
