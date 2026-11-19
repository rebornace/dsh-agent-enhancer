/**
 * Browser driver abstraction for Desktop Browser Agent tools.
 * Shipping path is Playwright only (MV3 bridge retired).
 */

import type {
  CaptureEntry,
  CaptureKind,
} from './capture.ts'
import type { DemoStep } from './demo.ts'
import type {
  ExtractBody,
  SnapshotBody,
  StatusBody,
  TabListBody,
} from './protocol.ts'

export interface EmulateResult {
  readonly url: string
  readonly title: string
  readonly applied: readonly string[]
  readonly tabId?: number
}

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
  /** Keyboard press in the bound tab (replaying a recorded Enter). */
  press(key: string): Promise<BrowserActResult>
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
  /**
   * Close tabs nobody used for `idleMs`. Never closes `keep` ids, the active
   * page, or the last remaining tab. Returns the ids that were closed.
   */
  sweepIdleTabs(input: {
    readonly idleMs: number
    readonly keep?: readonly number[]
  }): Promise<readonly number[]>
  /** Start buffering console + network for every page (idempotent). */
  startCapture(): void
  /** Stop buffering and drop what was buffered (switch off / teardown). */
  stopCapture(): void
  /** Read buffered entries; `kind` selects network, console or both. */
  readCapture(input: {
    readonly kind: CaptureKind
    readonly limit?: number
    readonly clear?: boolean
    /** Only this tab's entries; omit for every tab. */
    readonly tabId?: number
  }): { readonly entries: readonly CaptureEntry[]; readonly dropped: number; readonly skipped: number }
  /** Page-level emulation (media features, viewport). Returns what was applied. */
  emulate(input: {
    readonly colorScheme?: 'light' | 'dark' | 'no-preference' | 'reset'
    readonly reducedMotion?: 'reduce' | 'no-preference' | 'reset'
    readonly viewport?: { readonly width: number; readonly height: number }
  }): Promise<EmulateResult>
  /** Start recording what the user does in the bound tab (one flow at a time). */
  startDemonstration(): Promise<void>
  /** True while a demonstration is being recorded. */
  demonstrationActive(): boolean
  /** Stop recording and return the flow as replayable steps. */
  stopDemonstration(): Promise<readonly DemoStep[]>
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
