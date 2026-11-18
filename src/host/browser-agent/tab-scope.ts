/**
 * Per-tab write guard ("read-only tab").
 *
 * The approval dialog guards one action at a time; a read-only tab is the
 * coarser, calmer control users actually ask for on sensitive pages (mail,
 * banking, a production console): the agent may read and scroll, but every
 * mutating tool fails fast with an actionable message instead of prompting.
 *
 * Scope is keyed by tab id, which TabRegistry never reuses, so a stale entry can
 * never silently authorise or block a different tab.
 */

export class TabScopeStore {
  private readonly readOnlyTabs = new Set<number>()

  setReadOnly(tabId: number, readOnly: boolean): void {
    if (readOnly) {
      this.readOnlyTabs.add(tabId)
      return
    }
    this.readOnlyTabs.delete(tabId)
  }

  isReadOnly(tabId: number | undefined): boolean {
    return tabId !== undefined && this.readOnlyTabs.has(tabId)
  }

  /** Drop scopes for tabs that no longer exist. */
  retain(tabIds: Iterable<number>): void {
    const alive = new Set(tabIds)
    for (const tabId of [...this.readOnlyTabs]) {
      if (!alive.has(tabId)) this.readOnlyTabs.delete(tabId)
    }
  }

  clear(): void {
    this.readOnlyTabs.clear()
  }

  /** Model-facing refusal, shared so every mutating tool says the same thing. */
  refusal(tabId: number): string {
    return `tab_read_only: tab ${tabId} is read-only (set by the user). Nothing was changed. `
      + 'Reading tools still work: browser_snapshot, browser_extract, browser_scroll, browser_wait. '
      + 'Ask the user to unlock the tab in the sidebar tab list, or open a new tab with browser_navigate({ newTab: true }).'
  }
}
