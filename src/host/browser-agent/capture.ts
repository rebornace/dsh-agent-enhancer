/**
 * Bounded network / console capture for the browser agent.
 *
 * Deliberately records only what a user can read off the page: URL, method,
 * status, timing, console text. Headers, cookies and bodies are never read, so
 * there is nothing to redact out of them — a token that appears in a URL is
 * masked by `redactUrl`.
 */

export interface NetworkCaptureEntry {
  readonly kind: 'request'
  readonly at: number
  readonly tabId: number
  readonly method: string
  readonly url: string
  readonly resourceType: string
  readonly status?: number
  readonly durationMs?: number
  readonly failure?: string
}

export interface ConsoleCaptureEntry {
  readonly kind: 'console'
  readonly at: number
  readonly tabId: number
  readonly level: string
  readonly text: string
  readonly location?: string
}

export type CaptureEntry = NetworkCaptureEntry | ConsoleCaptureEntry

export type CaptureKind = 'network' | 'console' | 'all'

const SECRET_PARAM = /^(access_?token|id_?token|auth|authorization|code|key|password|secret|session|sessionid|sig|signature|token)$/i
const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/g

/** Mask userinfo and secret-looking query values; drop the fragment. */
export function redactUrl(raw: string): string {
  const withoutUserInfo = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1')
  const withoutFragment = withoutUserInfo.replace(/#.*$/, '')
  const masked = withoutFragment.replace(
    /([?&])([^=&#]+)=([^&#]*)/g,
    (match, separator: string, key: string) => (SECRET_PARAM.test(decodeURIComponent(key)) ? `${separator}${key}=***` : match),
  )
  return masked.length > 300 ? `${masked.slice(0, 300)}…` : masked
}

/**
 * Redact every http(s) URL inside free text. Console messages embed request URLs
 * (a failed resource logs its full URL), so redacting only the network layer
 * would leak a token that the network layer had masked.
 */
export function redactText(text: string): string {
  return text.replace(URL_IN_TEXT, match => {
    const trailing = match.match(/[),.;]+$/)?.[0] ?? ''
    const core = trailing === '' ? match : match.slice(0, -trailing.length)
    return `${redactUrl(core)}${trailing}`
  })
}

export class CaptureBuffer {
  private readonly entries: CaptureEntry[] = []
  private dropped = 0

  constructor(private readonly max = 300) {}

  get size(): number {
    return this.entries.length
  }

  push(entry: CaptureEntry): void {
    this.entries.push(entry)
    while (this.entries.length > this.max) {
      this.entries.shift()
      this.dropped += 1
    }
  }

  /** Newest `limit` entries of the requested kind, optionally clearing them. */
  read(kind: CaptureKind, options: {
    readonly limit?: number
    readonly clear?: boolean
    /** Only entries from this tab; omit for every tab. */
    readonly tabId?: number
  } = {}): {
    readonly entries: readonly CaptureEntry[]
    readonly dropped: number
    /** Matching entries from other tabs, so the caller can offer "all tabs". */
    readonly skipped: number
  } {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 40), 1), 200)
    const ofKind = this.entries.filter(entry => kind === 'all' || entry.kind === (kind === 'network' ? 'request' : 'console'))
    const matched = options.tabId === undefined
      ? ofKind
      : ofKind.filter(entry => entry.tabId === options.tabId)
    const skipped = ofKind.length - matched.length
    const selected = matched.slice(-limit)
    if (options.clear === true) {
      const keep = this.entries.filter(entry => !selected.includes(entry))
      this.entries.length = 0
      this.entries.push(...keep)
    }
    return { entries: selected, dropped: this.dropped, skipped }
  }

  clear(): void {
    this.entries.length = 0
    this.dropped = 0
  }
}
