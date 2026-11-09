import { WEB_CHAT_MAX_MESSAGES, WEB_CHAT_MAX_TEXT_BYTES } from './limits.ts'
import type { WebChatRole, WebChatTranscript, WebChatTurn } from './types.ts'

const SHARE_URL_RE = /(?:https?:\/\/chat\.deepseek\.com)?\/share\/([A-Za-z0-9_-]+)/i
const SHARE_ID_RE = /^[A-Za-z0-9_-]{6,}$/

export function extractWebChatShareId(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const fromUrl = trimmed.match(SHARE_URL_RE)
  if (fromUrl?.[1]) return fromUrl[1]
  if (SHARE_ID_RE.test(trimmed)) return trimmed
  return null
}

export function webChatSharePageUrl(shareId: string): string {
  return `https://chat.deepseek.com/share/${shareId}`
}

export function webChatShareContentApiUrl(shareId: string): string {
  return `https://chat.deepseek.com/api/v0/share/content?share_id=${encodeURIComponent(shareId)}`
}

export function webChatSessionListApiUrl(count = 100): string {
  return `https://chat.deepseek.com/api/v0/chat_session/fetch_page?count=${Math.max(1, Math.min(count, 100))}`
}

export function webChatHistoryMessagesApiUrl(chatSessionId: string): string {
  return `https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(chatSessionId)}`
}

function normalizeRole(raw: unknown): WebChatRole | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toLowerCase()
  if (key === 'user' || key === 'human') return 'user'
  if (key === 'assistant' || key === 'ai' || key === 'model') return 'assistant'
  return null
}

function messageText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim()
  if (Array.isArray(raw)) {
    return raw
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
      .trim()
  }
  return ''
}

/** DeepSeek share / history payloads store body text in `fragments`, not top-level `content`. */
function fragmentsText(fragments: unknown, preferTypes: readonly string[]): string {
  if (!Array.isArray(fragments)) return ''
  const preferred = new Set(preferTypes.map(type => type.toUpperCase()))
  const preferredParts: string[] = []
  const fallbackParts: string[] = []
  for (const frag of fragments) {
    if (frag === null || typeof frag !== 'object') continue
    const type = String(Reflect.get(frag, 'type') ?? '').toUpperCase()
    const content = Reflect.get(frag, 'content')
    if (typeof content !== 'string' || content.trim() === '') continue
    const text = content.trim()
    // Skip non-answer tooling / tips when we have preferred body types.
    if (type === 'THINK' || type === 'TIP' || type.startsWith('TOOL_')) {
      if (preferred.size === 0) fallbackParts.push(text)
      continue
    }
    if (preferred.size === 0 || preferred.has(type)) preferredParts.push(text)
    else fallbackParts.push(text)
  }
  if (preferredParts.length > 0) return preferredParts.join('\n\n')
  return fallbackParts.join('\n\n')
}

function rowText(item: Record<string, unknown>, role: WebChatRole): string {
  const direct = messageText(item.content ?? item.text ?? item.message)
  if (direct) return direct
  if (role === 'user') return fragmentsText(item.fragments, ['REQUEST'])
  return fragmentsText(item.fragments, ['RESPONSE'])
}

function assertTurns(turns: readonly WebChatTurn[]): void {
  if (turns.length === 0) {
    throw new Error('Share link has no messages')
  }
  if (turns.length > WEB_CHAT_MAX_MESSAGES) {
    throw new Error(`Exceeds message limit (${WEB_CHAT_MAX_MESSAGES})`)
  }
  let bytes = 0
  for (const turn of turns) {
    bytes += Buffer.byteLength(turn.text, 'utf8')
    if (bytes > WEB_CHAT_MAX_TEXT_BYTES) {
      throw new Error(`Share content exceeds ${WEB_CHAT_MAX_TEXT_BYTES} byte limit`)
    }
  }
}

function bizRecord(data: unknown): Record<string, unknown> | null {
  if (data === null || typeof data !== 'object') return null
  const root = data as Record<string, unknown>
  if (Reflect.get(root, 'code') !== 0 && Reflect.get(root, 'code') !== undefined) {
    const msg = Reflect.get(root, 'msg')
    throw new Error(
      typeof msg === 'string' && msg.trim() !== ''
        ? `share-api: ${msg}`
        : 'share-api: request failed',
    )
  }
  const payload = Reflect.get(root, 'data')
  const biz = payload !== null && typeof payload === 'object'
    ? Reflect.get(payload as object, 'biz_data')
    : undefined
  if (biz !== null && typeof biz === 'object') return biz as Record<string, unknown>
  return root
}

function turnsFromBizRecord(record: Record<string, unknown>): WebChatTurn[] {
  const rowsRaw = record.messages ?? record.chat_messages
  const rows = Array.isArray(rowsRaw) ? rowsRaw : []
  const turns: WebChatTurn[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    const role = normalizeRole(item.role ?? item.author ?? item.speaker)
    if (!role) continue
    const text = rowText(item, role)
    if (!text) continue
    turns.push({ role, text })
  }
  return turns
}

/** Map DeepSeek public share API JSON into a transcript. */
export function parseWebChatShareContent(
  data: unknown,
  options: { readonly shareUrl: string, readonly shareId: string },
): WebChatTranscript {
  const record = bizRecord(data)
  if (record === null) {
    throw new Error('unrecognized-share: empty response')
  }

  const titleRaw = record.title
  const title = typeof titleRaw === 'string' && titleRaw.trim() !== ''
    ? titleRaw.trim()
    : `Shared chat ${options.shareId}`

  const turns = turnsFromBizRecord(record)
  assertTurns(turns)

  return {
    title,
    turns,
    partial: false,
    source: {
      kind: 'share-link',
      url: options.shareUrl,
      chatSessionId: options.shareId,
      capturedAt: new Date().toISOString(),
    },
  }
}

/** Map logged-in `history_messages` JSON into a transcript. */
export function parseWebChatHistoryMessages(
  data: unknown,
  options: {
    readonly chatSessionId: string
    readonly title?: string
  },
): WebChatTranscript {
  const record = bizRecord(data)
  if (record === null) {
    throw new Error('unrecognized-history: empty response')
  }

  const session = Reflect.get(record, 'chat_session')
  const sessionTitle = session !== null && typeof session === 'object'
    ? Reflect.get(session as object, 'title')
    : undefined
  const titleFromApi = typeof sessionTitle === 'string' && sessionTitle.trim() !== ''
    ? sessionTitle.trim()
    : undefined
  const title = (options.title?.trim() || titleFromApi || `Chat ${options.chatSessionId}`).trim()

  const turns = turnsFromBizRecord(record)
  if (turns.length === 0) {
    throw new Error('Account history has no messages')
  }
  assertTurns(turns)

  return {
    title,
    turns,
    partial: false,
    source: {
      kind: 'account-history',
      chatSessionId: options.chatSessionId,
      capturedAt: new Date().toISOString(),
    },
  }
}

export interface WebChatAccountSessionRow {
  readonly id: string
  readonly title: string
  readonly updatedAt?: number
}

/** Map `chat_session/fetch_page` into selectable session rows. */
export function parseWebChatSessionList(data: unknown): {
  readonly items: readonly WebChatAccountSessionRow[]
  readonly hasMore: boolean
} {
  const record = bizRecord(data)
  if (record === null) {
    throw new Error('unrecognized-history: empty session list')
  }
  const rowsRaw = record.chat_sessions
  const rows = Array.isArray(rowsRaw) ? rowsRaw : []
  const items: WebChatAccountSessionRow[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (id === '') continue
    const title = typeof item.title === 'string' && item.title.trim() !== ''
      ? item.title.trim()
      : `Chat ${id}`
    const updatedAt = typeof item.updated_at === 'number'
      ? item.updated_at
      : typeof item.updated_at === 'string' && Number.isFinite(Number(item.updated_at))
        ? Number(item.updated_at)
        : undefined
    items.push({ id, title, ...(updatedAt === undefined ? {} : { updatedAt }) })
  }
  if (items.length === 0) {
    throw new Error('Account history is empty')
  }
  return {
    items,
    hasMore: Reflect.get(record, 'has_more') === true,
  }
}

export async function fetchWebChatShareContent(
  shareId: string,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted()
  const response = await fetch(webChatShareContentApiUrl(shareId), {
    method: 'GET',
    signal,
    headers: {
      accept: 'application/json, text/plain, */*',
      referer: 'https://chat.deepseek.com/',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    },
  })
  if (!response.ok) {
    throw new Error(`share-api: HTTP ${response.status}`)
  }
  return await response.json() as unknown
}

export async function resolveWebChatShareLink(
  shareUrlOrId: string,
  signal: AbortSignal,
): Promise<WebChatTranscript> {
  const shareId = extractWebChatShareId(shareUrlOrId)
  if (shareId === null) {
    throw new Error('unrecognized-share: not a DeepSeek share link')
  }
  const shareUrl = webChatSharePageUrl(shareId)
  const data = await fetchWebChatShareContent(shareId, signal)
  return parseWebChatShareContent(data, { shareUrl, shareId })
}
