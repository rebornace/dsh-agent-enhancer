/** Default localhost port for the MV3 extension WebSocket bridge. */
export const BROWSER_AGENT_DEFAULT_PORT = 38_473

export type BrowserBridgeClientMessage =
  | { readonly type: 'hello'; readonly extensionVersion?: string }
  | { readonly type: 'pong'; readonly id: string }
  | {
    readonly type: 'result'
    readonly id: string
    readonly ok: true
    readonly body: unknown
  }
  | {
    readonly type: 'result'
    readonly id: string
    readonly ok: false
    readonly error: string
    readonly needsHuman?: boolean
  }
  | {
    readonly type: 'event'
    readonly name: 'tab-focus-conflict'
    readonly boundTabId: number
    readonly activeTabId: number
  }
  | {
    readonly type: 'event'
    readonly name: 'tab-closed'
    readonly tabId: number
  }

export type BrowserBridgeHostMessage =
  | { readonly type: 'ping'; readonly id: string }
  | { readonly type: 'navigate'; readonly id: string; readonly url: string }
  | { readonly type: 'snapshot'; readonly id: string }
  | {
    readonly type: 'act'
    readonly id: string
    readonly action: 'click' | 'type' | 'scroll'
    readonly ref?: number
    readonly text?: string
    readonly dy?: number
  }
  | { readonly type: 'screenshot'; readonly id: string }
  | { readonly type: 'status'; readonly id: string }
  | {
    readonly type: 'bind'
    readonly id: string
    readonly tabId: number
    readonly sessionId?: string
  }
  | {
    readonly type: 'resolve-conflict'
    readonly id: string
    readonly decision: 'follow' | 'stay'
  }
  | { readonly type: 'list-tabs'; readonly id: string }
  | {
    readonly type: 'follow-tab'
    readonly id: string
    readonly tabId: number
    readonly activate?: boolean
  }
  | {
    readonly type: 'wait'
    readonly id: string
    readonly timeoutMs?: number
    readonly text?: string
  }
  | {
    readonly type: 'extract'
    readonly id: string
    /** Optional focus hint returned to the model; never used for site matching. */
    readonly focus?: string
    readonly maxChars?: number
  }

export interface SnapshotNode {
  readonly ref: number
  readonly role: string
  readonly name: string
  readonly tag?: string
  /** Absolute http(s) href when the control is (or is inside) a link — prefer browser_navigate when click is a no-op. */
  readonly href?: string
  /** True when the node is a password (or similar) field — value never exposed. */
  readonly sensitive?: boolean
}

export interface SnapshotBody {
  readonly url: string
  readonly title: string
  readonly nodes: readonly SnapshotNode[]
  readonly textPreview: string
  readonly needsHuman?: boolean
  readonly tabId?: number
  readonly rebound?: boolean
  readonly conflict?: boolean
  /** How the snapshot was built (accessibility / accessibility+anchors / dom-fallback). */
  readonly source?: string
  /** Optional guidance when the page exposes no navigable hrefs on refs. */
  readonly note?: string
  /** MV3 extension build id — use to verify desktop:link + browser relaunch. */
  readonly extensionVersion?: string
  /** Live document anchors harvested during snapshot (0 ⇒ harvest failed or page empty). */
  readonly anchorCount?: number
}

export interface ExtractBody {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly truncated: boolean
  readonly focus?: string
  readonly tabId?: number
}

export interface StatusBody {
  readonly connected: true
  readonly url: string
  readonly title: string
  readonly tabId: number
  readonly bound?: boolean
  readonly rebound?: boolean
  readonly conflict?: boolean
}

export interface TabListEntry {
  readonly tabId: number
  readonly title: string
  readonly url: string
  readonly active: boolean
  readonly bound: boolean
}

export interface TabListBody {
  readonly tabs: readonly TabListEntry[]
  readonly boundTabId: number | null
}

export function originOfUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

