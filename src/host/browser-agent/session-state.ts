/** Per-session browser-agent memory (tabs, human waits, action audit). */

export interface BrowserTabConflict {
  readonly sessionId: string
  readonly boundTabId: number
  readonly activeTabId: number
}

export interface BrowserAuditEntry {
  readonly at: number
  readonly sessionId: string
  readonly tool: string
  readonly summary: string
  readonly url?: string
  readonly outcome: 'ok' | 'denied' | 'error' | 'needs_human'
}

const MAX_AUDIT = 40

export class BrowserSessionState {
  private readonly tabBySession = new Map<string, number>()
  private readonly sessionByTab = new Map<number, string>()
  private readonly needsHumanBySession = new Map<string, string>()
  /** Refs from the latest successful browser_snapshot for this session. */
  private readonly lastRefsBySession = new Map<string, ReadonlySet<number>>()
  /** Optional href per ref from the latest snapshot (follow only that ref's href after a dead click). */
  private readonly lastHrefBySession = new Map<string, ReadonlyMap<number, string>>()
  /** Optional accessible name per ref from the latest snapshot (name-matched auto-nav). */
  private readonly lastNameBySession = new Map<string, ReadonlyMap<number, string>>()
  /** Refs that already failed a click with no navigation — block re-click until a fresh snapshot. */
  private readonly deadClickRefsBySession = new Map<string, Set<number>>()
  /** Last http(s) page URL for approval origin when pageStatus is blank/about:blank. */
  private readonly lastHttpUrlBySession = new Map<string, string>()
  private conflict: BrowserTabConflict | null = null
  private readonly audit: BrowserAuditEntry[] = []

  bind(sessionId: string, tabId: number): void {
    const prev = this.tabBySession.get(sessionId)
    if (prev !== undefined && prev !== tabId) this.sessionByTab.delete(prev)
    const owner = this.sessionByTab.get(tabId)
    if (owner !== undefined && owner !== sessionId) this.tabBySession.delete(owner)
    this.tabBySession.set(sessionId, tabId)
    this.sessionByTab.set(tabId, sessionId)
    if (this.conflict?.sessionId === sessionId) this.conflict = null
  }

  tabOf(sessionId: string): number | undefined {
    return this.tabBySession.get(sessionId)
  }

  sessionOf(tabId: number): string | undefined {
    return this.sessionByTab.get(tabId)
  }

  clearSession(sessionId: string): void {
    const tabId = this.tabBySession.get(sessionId)
    this.tabBySession.delete(sessionId)
    if (tabId !== undefined) this.sessionByTab.delete(tabId)
    this.needsHumanBySession.delete(sessionId)
    this.lastRefsBySession.delete(sessionId)
    this.lastHrefBySession.delete(sessionId)
    this.lastNameBySession.delete(sessionId)
    this.deadClickRefsBySession.delete(sessionId)
    this.lastHttpUrlBySession.delete(sessionId)
    if (this.conflict?.sessionId === sessionId) this.conflict = null
    for (let i = this.audit.length - 1; i >= 0; i -= 1) {
      if (this.audit[i]?.sessionId === sessionId) this.audit.splice(i, 1)
    }
  }

  setLastRefs(sessionId: string, refs: readonly number[]): void {
    this.lastRefsBySession.set(sessionId, new Set(refs.filter(ref => Number.isFinite(ref))))
    // Fresh snapshot clears dead-click bans for this session.
    this.deadClickRefsBySession.delete(sessionId)
  }

  setLastHrefs(sessionId: string, hrefs: ReadonlyMap<number, string>): void {
    this.lastHrefBySession.set(sessionId, hrefs)
  }

  setLastNames(sessionId: string, names: ReadonlyMap<number, string>): void {
    this.lastNameBySession.set(sessionId, names)
  }

  clearLastRefs(sessionId: string): void {
    this.lastRefsBySession.delete(sessionId)
    this.lastHrefBySession.delete(sessionId)
    this.lastNameBySession.delete(sessionId)
  }

  markDeadClickRef(sessionId: string, ref: number): void {
    const set = this.deadClickRefsBySession.get(sessionId) ?? new Set<number>()
    set.add(ref)
    this.deadClickRefsBySession.set(sessionId, set)
  }

  isDeadClickRef(sessionId: string, ref: number): boolean {
    return this.deadClickRefsBySession.get(sessionId)?.has(ref) === true
  }

  hasRef(sessionId: string, ref: number): boolean {
    return this.lastRefsBySession.get(sessionId)?.has(ref) === true
  }

  hrefOfRef(sessionId: string, ref: number): string | undefined {
    return this.lastHrefBySession.get(sessionId)?.get(ref)
  }

  nameOfRef(sessionId: string, ref: number): string | undefined {
    return this.lastNameBySession.get(sessionId)?.get(ref)
  }

  rememberHttpUrl(sessionId: string, url: string): void {
    if (!/^https?:\/\//i.test(url)) return
    this.lastHttpUrlBySession.set(sessionId, url)
  }

  lastHttpUrl(sessionId: string): string | undefined {
    return this.lastHttpUrlBySession.get(sessionId)
  }

  lastRefList(sessionId: string): readonly number[] {
    return [...(this.lastRefsBySession.get(sessionId) ?? [])]
  }

  setConflict(conflict: BrowserTabConflict): void {
    this.conflict = conflict
  }

  clearConflict(sessionId?: string): void {
    if (sessionId === undefined || this.conflict?.sessionId === sessionId) this.conflict = null
  }

  currentConflict(): BrowserTabConflict | null {
    return this.conflict
  }

  setNeedsHuman(sessionId: string, detail: string): void {
    this.needsHumanBySession.set(sessionId, detail)
  }

  clearNeedsHuman(sessionId: string): void {
    this.needsHumanBySession.delete(sessionId)
  }

  needsHuman(sessionId: string): string | undefined {
    return this.needsHumanBySession.get(sessionId)
  }

  anyNeedsHuman(): { sessionId: string, detail: string } | null {
    for (const [sessionId, detail] of this.needsHumanBySession) {
      return { sessionId, detail }
    }
    return null
  }

  record(entry: Omit<BrowserAuditEntry, 'at'>): void {
    this.audit.push({ ...entry, at: Date.now() })
    while (this.audit.length > MAX_AUDIT) this.audit.shift()
  }

  recentAudit(limit = 12): readonly BrowserAuditEntry[] {
    return this.audit.slice(-limit)
  }
}
