import {
  parseWebChatRichMessage,
  richMessagesToPreviewTurns,
  type WebChatRichMessage,
} from './fragments.ts'
import { WEB_CHAT_MAX_MESSAGES, WEB_CHAT_MAX_TEXT_BYTES } from './limits.ts'
import type { WebChatTranscript, WebChatTurn } from './types.ts'

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

/** UTF-8 byte length — works in both Host (Node) and client (browser). */
function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
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
    bytes += utf8ByteLength(turn.text)
    if (bytes > WEB_CHAT_MAX_TEXT_BYTES) {
      throw new Error(`Share content exceeds ${WEB_CHAT_MAX_TEXT_BYTES} byte limit`)
    }
  }
}

function assertRichBudget(messages: readonly WebChatRichMessage[]): void {
  if (messages.length > WEB_CHAT_MAX_MESSAGES) {
    throw new Error(`Exceeds message limit (${WEB_CHAT_MAX_MESSAGES})`)
  }
  let bytes = 0
  for (const message of messages) {
    for (const frag of message.fragments) {
      if ('content' in frag && typeof frag.content === 'string') {
        bytes += utf8ByteLength(frag.content)
      }
      if (bytes > WEB_CHAT_MAX_TEXT_BYTES) {
        throw new Error(`Share content exceeds ${WEB_CHAT_MAX_TEXT_BYTES} byte limit`)
      }
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

function messagesFromBizRecord(record: Record<string, unknown>): WebChatRichMessage[] {
  const rowsRaw = record.messages ?? record.chat_messages
  const rows = Array.isArray(rowsRaw) ? rowsRaw : []
  const messages: WebChatRichMessage[] = []
  for (let i = 0; i < rows.length; i++) {
    const parsed = parseWebChatRichMessage(rows[i], i + 1)
    if (parsed !== null) messages.push(parsed)
  }
  return messages
}

function coerceMessageId(raw: unknown): number | null | undefined {
  if (raw === null) return null
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw)
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return undefined
}

function currentMessageIdOf(record: Record<string, unknown>): number | null | undefined {
  const fromRoot = coerceMessageId(record.current_message_id)
  if (fromRoot !== undefined) return fromRoot
  const session = Reflect.get(record, 'chat_session')
  if (session !== null && typeof session === 'object') {
    return coerceMessageId(Reflect.get(session as object, 'current_message_id'))
  }
  return undefined
}

function transcriptFromBiz(
  record: Record<string, unknown>,
  title: string,
  source: WebChatTranscript['source'],
): WebChatTranscript {
  const messages = messagesFromBizRecord(record)
  assertRichBudget(messages)
  const turns = richMessagesToPreviewTurns(messages)
  assertTurns(turns)
  const currentMessageId = currentMessageIdOf(record)
  return {
    title,
    turns,
    messages,
    ...(currentMessageId === undefined ? {} : { currentMessageId }),
    partial: false,
    source,
  }
}

/** Map DeepSeek public share API JSON into a transcript. */
export function parseWebChatShareContent(
  data: unknown,
  options: { readonly shareUrl: string; readonly shareId: string },
): WebChatTranscript {
  const record = bizRecord(data)
  if (record === null) {
    throw new Error('unrecognized-share: empty response')
  }

  const titleRaw = record.title
  const title = typeof titleRaw === 'string' && titleRaw.trim() !== ''
    ? titleRaw.trim()
    : `Shared chat ${options.shareId}`

  return transcriptFromBiz(record, title, {
    kind: 'share-link',
    url: options.shareUrl,
    chatSessionId: options.shareId,
    capturedAt: new Date().toISOString(),
  })
}

/** Map logged-in `history_messages` JSON into a transcript. */
export function parseWebChatHistoryMessages(
  data: unknown,
  options: {
    readonly chatSessionId: string
    readonly title?: string
    readonly url?: string
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

  try {
    return transcriptFromBiz(record, title, {
      kind: 'account-history',
      chatSessionId: options.chatSessionId,
      ...(options.url === undefined || options.url.trim() === '' ? {} : { url: options.url }),
      capturedAt: new Date().toISOString(),
    })
  } catch (error) {
    if (error instanceof Error && /no messages/i.test(error.message)) {
      throw new Error('Account history has no messages')
    }
    throw error
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
