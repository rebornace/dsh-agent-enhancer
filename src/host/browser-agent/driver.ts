/**
 * Browser driver abstraction for Desktop Browser Agent tools.
 * Shipping path is Playwright only (MV3 bridge retired).
 */

import type {
  ExtractBody,
  SnapshotBody,
  StatusBody,
  TabListBody,
} from './protocol.ts'

export type BrowserDriverKind = 'playwright'

export interface BrowserDriverStatus {
  readonly kind: BrowserDriverKind
  /** True when the driver can accept page ops (persistent context live). */
  readonly ready: boolean
  /** Playwright: process/context available. */
  readonly listening: boolean
  readonly port?: number
  readonly lastError?: string | null
  /** Human-readable endpoint (e.g. playwright:msedge). */
  readonly endpoint?: string
}

export interface BrowserActResult {
  readonly url: string
  readonly title: string
  readonly tabId?: number
  readonly changed?: boolean
  readonly href?: string
  readonly warning?: string
  readonly pageLinks?: ReadonlyArray<{ readonly href: string; readonly name?: string }>
}

export interface BrowserDriver {
  readonly kind: BrowserDriverKind

  status(): BrowserDriverStatus

  /** Launch/reuse the dedicated persistent browser context. */
  ensureReady(startUrl?: string): Promise<void>

  pageStatus(): Promise<StatusBody>
  navigate(
    url: string,
    options?: { readonly newTab?: boolean },
  ): Promise<{ readonly url: string; readonly title: string; readonly tabId?: number }>
  snapshot(): Promise<SnapshotBody>
  extract(input?: { readonly focus?: string; readonly maxChars?: number }): Promise<ExtractBody>
  click(ref: number): Promise<BrowserActResult>
  type(ref: number, text: string): Promise<BrowserActResult>
  scroll(dy: number): Promise<BrowserActResult>
  wait(input?: {
    readonly timeoutMs?: number
    readonly text?: string
  }): Promise<{
    readonly url: string
    readonly title: string
    readonly matched: boolean
    readonly tabId?: number
  }>
  screenshot(): Promise<{ readonly mime: string; readonly base64: string; readonly tabId?: number }>
  listTabs(): Promise<TabListBody>
  followTab(tabId: number, activate?: boolean): Promise<{
    readonly tabId: number
    readonly url: string
    readonly title: string
  }>
  bind(tabId: number, sessionId?: string): Promise<{
    readonly tabId: number
    readonly url: string
    readonly title: string
  }>

  dispose(): Promise<void>
}
