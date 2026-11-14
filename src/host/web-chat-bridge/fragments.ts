/**
 * Fragment vocabulary shared by DeepSeek share / history_messages payloads and
 * the official `deepseek_data` export (export_format_version: 3). Only types the
 * single-path importer maps are modeled; TIP / TOOL_FIND / etc. are ignored.
 */

export type WebChatExportRole = 'USER' | 'ASSISTANT'

export type WebChatFragment =
  | { readonly type: 'REQUEST'; readonly content: string }
  | { readonly type: 'RESPONSE'; readonly content: string }
  | { readonly type: 'THINK'; readonly content: string; readonly elapsed_secs?: number | null }
  | { readonly type: 'TEMPLATE_RESPONSE'; readonly content: string }
  | {
    readonly type: 'TOOL_SEARCH'
    readonly queries: readonly string[]
    readonly results: readonly WebChatSearchResult[]
    readonly status?: string
    readonly stage_id?: number | null
  }
  | {
    readonly type: 'TOOL_OPEN'
    readonly status: string
    readonly url: string | null
    readonly title?: string | null
    readonly stage_id?: number | null
  }
  | {
    readonly type: 'READ_LINK'
    readonly results: readonly { readonly url?: string | null; readonly title?: string | null }[]
  }

export interface WebChatSearchResult {
  readonly url: string
  readonly title?: string | null
  readonly snippet?: string | null
  readonly published_at?: string | null
}

export interface WebChatRichMessage {
  readonly id: number
  readonly parent_id: number | null
  readonly role: WebChatExportRole
  readonly status: string
  readonly inserted_at?: string
  readonly fragments: readonly WebChatFragment[]
}

export interface WebChatRichConversation {
  readonly title: string | null
  readonly current_message_id?: number | null
  readonly messages: readonly WebChatRichMessage[]
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function parseSearchResults(raw: unknown): WebChatSearchResult[] {
  if (!Array.isArray(raw)) return []
  const out: WebChatSearchResult[] = []
  for (const row of raw) {
    if (row === null || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    const url = nonEmptyString(item.url)
    if (url === undefined) continue
    out.push({
      url,
      title: typeof item.title === 'string' || item.title === null ? item.title : undefined,
      snippet: typeof item.snippet === 'string' || item.snippet === null ? item.snippet : undefined,
      published_at:
        typeof item.published_at === 'string' || item.published_at === null
          ? item.published_at
          : undefined,
    })
  }
  return out
}

function parseReadLinkResults(
  raw: unknown,
): { readonly url?: string | null; readonly title?: string | null }[] {
  if (!Array.isArray(raw)) return []
  const out: { url?: string | null; title?: string | null }[] = []
  for (const row of raw) {
    if (row === null || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    out.push({
      url: typeof item.url === 'string' || item.url === null ? item.url : undefined,
      title: typeof item.title === 'string' || item.title === null ? item.title : undefined,
    })
  }
  return out
}

/** Parse one fragment envelope; unknown / unmapped types return undefined. */
export function parseWebChatFragment(raw: unknown): WebChatFragment | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const item = raw as Record<string, unknown>
  const type = String(item.type ?? '').toUpperCase()
  switch (type) {
    case 'REQUEST': {
      const content = typeof item.content === 'string' ? item.content : ''
      return { type: 'REQUEST', content }
    }
    case 'RESPONSE': {
      const content = typeof item.content === 'string' ? item.content : ''
      return { type: 'RESPONSE', content }
    }
    case 'THINK': {
      const content = typeof item.content === 'string' ? item.content : ''
      return {
        type: 'THINK',
        content,
        elapsed_secs: optionalNumber(item.elapsed_secs),
      }
    }
    case 'TEMPLATE_RESPONSE': {
      const content = typeof item.content === 'string' ? item.content : ''
      return { type: 'TEMPLATE_RESPONSE', content }
    }
    case 'TOOL_SEARCH': {
      const queries = Array.isArray(item.queries)
        ? item.queries.filter((q): q is string => typeof q === 'string')
        : []
      return {
        type: 'TOOL_SEARCH',
        queries,
        results: parseSearchResults(item.results),
        status: typeof item.status === 'string' ? item.status : undefined,
        stage_id: optionalNumber(item.stage_id),
      }
    }
    case 'TOOL_OPEN': {
      const url = item.url === null
        ? null
        : typeof item.url === 'string'
          ? item.url
          : null
      return {
        type: 'TOOL_OPEN',
        status: typeof item.status === 'string' ? item.status : 'FINISHED',
        url,
        title: typeof item.title === 'string' || item.title === null ? item.title : undefined,
        stage_id: optionalNumber(item.stage_id),
      }
    }
    case 'READ_LINK':
      return { type: 'READ_LINK', results: parseReadLinkResults(item.results) }
    default:
      return undefined
  }
}

function normalizeExportRole(raw: unknown): WebChatExportRole | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toUpperCase()
  if (key === 'USER' || key === 'HUMAN') return 'USER'
  if (key === 'ASSISTANT' || key === 'AI' || key === 'MODEL') return 'ASSISTANT'
  return null
}

function messageTextFallback(item: Record<string, unknown>): string {
  const content = item.content ?? item.text ?? item.message
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          const text = Reflect.get(part, 'text')
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** Coerce share / history numeric ids (`id`, `message_id`, string digits). */
function numberId(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw)
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return undefined
}

/**
 * Parse one API / export message row into a rich message.
 * Rows without a role are skipped (returns null).
 * Share payloads often use `message_id` / `parent_id` (not bare `id`).
 */
export function parseWebChatRichMessage(
  raw: unknown,
  fallbackId: number,
): WebChatRichMessage | null {
  if (raw === null || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const role = normalizeExportRole(item.role ?? item.author ?? item.speaker)
  if (role === null) return null

  const id = numberId(item.id)
    ?? numberId(item.message_id)
    ?? fallbackId
  const parent_id = numberId(item.parent_id)
    ?? numberId(item.parent_message_id)
    ?? null

  const fragments: WebChatFragment[] = []
  if (Array.isArray(item.fragments)) {
    for (const frag of item.fragments) {
      const parsed = parseWebChatFragment(frag)
      if (parsed !== undefined) fragments.push(parsed)
    }
  }

  if (fragments.length === 0) {
    const text = messageTextFallback(item)
    if (role === 'USER') fragments.push({ type: 'REQUEST', content: text })
    else fragments.push({ type: 'RESPONSE', content: text })
  }

  return {
    id,
    parent_id,
    role,
    status: typeof item.status === 'string' && item.status.trim() !== ''
      ? item.status.trim()
      : 'FINISHED',
    inserted_at: typeof item.inserted_at === 'string' ? item.inserted_at : undefined,
    fragments,
  }
}

/** REQUEST / RESPONSE text for preview lists (legacy flat turns). */
export function previewTextFromFragments(
  fragments: readonly WebChatFragment[],
  role: WebChatExportRole,
): string {
  const prefer = role === 'USER' ? 'REQUEST' : 'RESPONSE'
  const preferred: string[] = []
  for (const frag of fragments) {
    if (frag.type === prefer && frag.content.trim() !== '') {
      preferred.push(frag.content.trim())
    }
  }
  return preferred.join('\n\n')
}

export function richMessagesToPreviewTurns(
  messages: readonly WebChatRichMessage[],
): { role: 'user' | 'assistant'; text: string }[] {
  const turns: { role: 'user' | 'assistant'; text: string }[] = []
  for (const message of messages) {
    const text = previewTextFromFragments(message.fragments, message.role)
    if (text === '') continue
    turns.push({
      role: message.role === 'USER' ? 'user' : 'assistant',
      text,
    })
  }
  return turns
}
