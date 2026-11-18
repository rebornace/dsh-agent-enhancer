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

/** What a session remembers about one tab's last snapshot. */
interface RefMemory {
  refs: Set<number>
  hrefs: Map<number, string>
  names: Map<number, string>
  /** Refs that already failed a click with no navigation — block re-click until a fresh snapshot. */
  dead: Set<number>
}

function emptyMemory(): RefMemory {
  return { refs: new Set(), hrefs: new Map(), names: new Map(), dead: new Set() }
}

export class BrowserSessionState {
  private readonly tabBySession = new Map<string, number>()
  private readonly sessionByTab = new Map<number, string>()
  private readonly needsHumanBySession = new Map<string, { detail: string, kind: 'human' | 'ask' }>()
  /**
   * Snapshot memory lives with the tab, not the session: refs captured in a tab
   * stay valid when the session switches away and back (refs are unique per
   * driver, so there is no cross-tab aliasing).
   */
  private readonly memoryByTab = new Map<number, RefMemory>()
  /** Snapshots taken before a tab is bound (rare, first call) land here. */
  private readonly memoryUnbound = new Map<string, RefMemory>()
  /** Last http(s) page URL for approval origin when pageStatus is blank/about:blank. */
  private readonly lastHttpUrlBySession = new Map<string, string>()
  private conflict: BrowserTabConflict | null = null
  private readonly audit: BrowserAuditEntry[] = []

  /** Memory for this session's current tab, creating it on first use. */
  private memoryOf(sessionId: string): RefMemory {
    const tabId = this.tabBySession.get(sessionId)
    if (tabId === undefined) {
      let memory = this.memoryUnbound.get(sessionId)
      if (memory === undefined) {
        memory = emptyMemory()
        this.memoryUnbound.set(sessionId, memory)
      }
      return memory
    }
    let memory = this.memoryByTab.get(tabId)
    if (memory === undefined) {
      memory = emptyMemory()
      this.memoryByTab.set(tabId, memory)
    }
    return memory
  }

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

  /** Tab ids that some session is bound to; idle-close must never take these. */
  boundTabIds(): readonly number[] {
    return [...this.sessionByTab.keys()]
  }

  /**
   * The tab went away (closed by idle sweep or by the user): drop the binding and
   * the refs captured there, so the next tool call re-snapshots instead of
   * resolving refs that no longer exist.
   */
  unbindTab(tabId: number): string | undefined {
    const sessionId = this.sessionByTab.get(tabId)
    this.sessionByTab.delete(tabId)
    // Refs die with the tab, whether or not a session was bound to it.
    this.memoryByTab.delete(tabId)
    if (sessionId === undefined) return undefined
    if (this.tabBySession.get(sessionId) === tabId) this.tabBySession.delete(sessionId)
    this.memoryUnbound.delete(sessionId)
    if (this.conflict?.sessionId === sessionId) this.conflict = null
    return sessionId
  }

  /** Which tab still holds this ref (refs are driver-unique), if any. */
  tabHoldingRef(ref: number, exceptTabId?: number): number | undefined {
    for (const [tabId, memory] of this.memoryByTab) {
      if (tabId === exceptTabId) continue
      if (memory.refs.has(ref)) return tabId
    }
    return undefined
  }

  /** Drop snapshot memory for tabs that no longer exist. */
  retainTabs(tabIds: Iterable<number>): void {
    const alive = new Set(tabIds)
    for (const tabId of [...this.memoryByTab.keys()]) {
      if (!alive.has(tabId)) this.memoryByTab.delete(tabId)
    }
  }

  clearSession(sessionId: string): void {
    const tabId = this.tabBySession.get(sessionId)
    this.tabBySession.delete(sessionId)
    if (tabId !== undefined) {
      this.sessionByTab.delete(tabId)
      // The tab is reused by whoever binds next; never hand them this session's refs.
      this.memoryByTab.delete(tabId)
    }
    this.memoryUnbound.delete(sessionId)
    this.needsHumanBySession.delete(sessionId)
    this.lastHttpUrlBySession.delete(sessionId)
    if (this.conflict?.sessionId === sessionId) this.conflict = null
    for (let i = this.audit.length - 1; i >= 0; i -= 1) {
      if (this.audit[i]?.sessionId === sessionId) this.audit.splice(i, 1)
    }
  }

  setLastRefs(sessionId: string, refs: readonly number[]): void {
    const memory = this.memoryOf(sessionId)
    memory.refs = new Set(refs.filter(ref => Number.isFinite(ref)))
    // Fresh snapshot clears dead-click bans for this tab.
    memory.dead = new Set()
  }

  setLastHrefs(sessionId: string, hrefs: ReadonlyMap<number, string>): void {
    this.memoryOf(sessionId).hrefs = new Map(hrefs)
  }

  setLastNames(sessionId: string, names: ReadonlyMap<number, string>): void {
    this.memoryOf(sessionId).names = new Map(names)
  }

  clearLastRefs(sessionId: string): void {
    const memory = this.memoryOf(sessionId)
    memory.refs = new Set()
    memory.hrefs = new Map()
    memory.names = new Map()
  }

  markDeadClickRef(sessionId: string, ref: number): void {
    this.memoryOf(sessionId).dead.add(ref)
  }

  isDeadClickRef(sessionId: string, ref: number): boolean {
    return this.memoryOf(sessionId).dead.has(ref)
  }

  hasRef(sessionId: string, ref: number): boolean {
    return this.memoryOf(sessionId).refs.has(ref)
  }

  hrefOfRef(sessionId: string, ref: number): string | undefined {
    return this.memoryOf(sessionId).hrefs.get(ref)
  }

  nameOfRef(sessionId: string, ref: number): string | undefined {
    return this.memoryOf(sessionId).names.get(ref)
  }

  rememberHttpUrl(sessionId: string, url: string): void {
    if (!/^https?:\/\//i.test(url)) return
    this.lastHttpUrlBySession.set(sessionId, url)
  }

  lastHttpUrl(sessionId: string): string | undefined {
    return this.lastHttpUrlBySession.get(sessionId)
  }

  lastRefList(sessionId: string): readonly number[] {
    return [...this.memoryOf(sessionId).refs]
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

  setNeedsHuman(sessionId: string, detail: string, kind: 'human' | 'ask' = 'human'): void {
    this.needsHumanBySession.set(sessionId, { detail, kind })
  }

  clearNeedsHuman(sessionId: string): void {
    this.needsHumanBySession.delete(sessionId)
  }

  needsHuman(sessionId: string): string | undefined {
    return this.needsHumanBySession.get(sessionId)?.detail
  }

  anyNeedsHuman(): { sessionId: string, detail: string, kind: 'human' | 'ask' } | null {
    for (const [sessionId, value] of this.needsHumanBySession) {
      return { sessionId, detail: value.detail, kind: value.kind }
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
