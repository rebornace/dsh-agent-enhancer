/**
 * Stable tab ids and per-tab ref buckets for PlaywrightDriver.
 *
 * Two defects this fixes, both visible in multi-tab work:
 * - tab ids used to be `context.pages().indexOf(page) + 1`, so closing any tab
 *   renumbered every later tab and a stale id silently named a different tab;
 * - refs lived in one driver-global map, so a snapshot in another tab wiped the
 *   refs you were about to click.
 *
 * browse's contract, kept here: an id stays with its tab while that tab is open
 * and is never reused, and refs belong to the tab that produced them.
 */

const EMPTY_REFS: ReadonlyMap<number, never> = new Map<number, never>()

export class TabRegistry<T> {
  private readonly idByPage = new WeakMap<object, number>()
  private readonly pageById = new Map<number, object>()
  private readonly refsById = new Map<number, Map<number, T>>()
  private nextId = 1

  /** Stable id for a page, assigned on first sight. */
  idOf(page: object): number {
    const known = this.idByPage.get(page)
    if (known !== undefined) return known
    const id = this.nextId
    this.nextId += 1
    this.idByPage.set(page, id)
    this.pageById.set(id, page)
    this.refsById.set(id, new Map())
    return id
  }

  /** Forget a closed page. Its id is retired, never handed to another page. */
  release(page: object): void {
    const id = this.idByPage.get(page)
    if (id === undefined) return
    this.idByPage.delete(page)
    this.pageById.delete(id)
    this.refsById.delete(id)
  }

  page(tabId: number): object | undefined {
    return this.pageById.get(tabId)
  }

  refsOf(tabId: number): ReadonlyMap<number, T> {
    return this.refsById.get(tabId) ?? EMPTY_REFS
  }

  ref(tabId: number, ref: number): T | undefined {
    return this.refsById.get(tabId)?.get(ref)
  }

  setRefs(tabId: number, refs: Iterable<readonly [number, T]>): void {
    this.refsById.set(tabId, new Map(refs))
  }

  clearRefs(tabId: number): void {
    this.refsById.set(tabId, new Map())
  }

  /** Which other tab still holds this ref — used to explain a cross-tab mistake. */
  tabHolding(ref: number, exceptTabId: number): number | undefined {
    for (const [tabId, refs] of this.refsById) {
      if (tabId !== exceptTabId && refs.has(ref)) return tabId
    }
    return undefined
  }

  /** Actionable message for a ref that is not in the active tab. */
  unknownRefMessage(ref: number, activeTabId: number): string {
    const other = this.tabHolding(ref, activeTabId)
    if (other !== undefined) {
      return `Ref ${ref} belongs to tab ${other}; tab ${activeTabId} is active. `
        + `Switch back with browser_follow_tab (tabId ${other}) or call browser_snapshot for refs in this tab.`
    }
    return `Unknown ref ${ref}; call browser_snapshot first`
  }
}
