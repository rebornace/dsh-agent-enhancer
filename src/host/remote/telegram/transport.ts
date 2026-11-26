import { ChannelAuthError } from '../channels/types.ts'
import type { InboundItem, UpdatesPage } from '../channels/types.ts'

/**
 * Telegram Bot API transport.
 *
 * Long polling only: no webhook, no public address. The token is carried in the
 * URL path, so no error message may quote the URL. Everything is reduced to the
 * channel-neutral message shapes the poller understands.
 */

export interface TelegramCredentials {
  readonly token: string
  readonly botId?: string
  readonly username?: string
}

export class TelegramTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: { readonly status?: number; readonly retryAfterMs?: number } = {},
  ) {
    super(message)
    this.name = 'TelegramTransportError'
  }
}

export interface TelegramTransportOptions {
  readonly fetchImpl?: typeof fetch
  readonly apiBase?: string
  readonly pollTimeoutMs?: number
  readonly requestTimeoutMs?: number
}

const DEFAULT_API_BASE = 'https://api.telegram.org'
const DEFAULT_POLL_TIMEOUT_MS = 35_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const LONG_POLL_SECONDS = 25

interface TelegramResponse {
  readonly ok?: boolean
  readonly result?: unknown
  readonly description?: string
  readonly error_code?: number
  readonly parameters?: { readonly retry_after?: number }
}

function tokenIsWellFormed(token: string): boolean {
  return token.length > 0 && !/\s/.test(token) && !token.includes('/')
}

function textOf(message: Record<string, unknown>): string | undefined {
  const text = message.text
  return typeof text === 'string' && text.trim() !== '' ? text : undefined
}

function itemsOf(message: Record<string, unknown>): InboundItem[] {
  const text = textOf(message)
  if (text !== undefined) return [{ kind: 'text', text }]
  if (message.voice !== undefined) return [{ kind: 'voice' }]
  if (message.photo !== undefined) return [{ kind: 'image' }]
  if (message.document !== undefined) return [{ kind: 'file' }]
  return [{ kind: 'other' }]
}

function parseUpdate(update: unknown): { readonly cursorId: number; readonly message?: import('../channels/types.ts').InboundMessage } {
  if (update === null || typeof update !== 'object') return { cursorId: 0 }
  const record = update as Record<string, unknown>
  const updateId = typeof record.update_id === 'number' ? record.update_id : 0
  const message = record.message
  if (message === null || typeof message !== 'object') return { cursorId: updateId }
  const item = message as Record<string, unknown>
  const chat = item.chat
  const chatRecord = chat !== null && typeof chat === 'object' ? chat as Record<string, unknown> : {}
  const chatId = typeof chatRecord.id === 'number' ? String(chatRecord.id) : undefined
  // Bound chats are personal; a group would be one shared control surface.
  if (chatId === undefined || chatRecord.type !== 'private') return { cursorId: updateId }
  const from = item.from
  const fromRecord = from !== null && typeof from === 'object' ? from as Record<string, unknown> : {}
  const fromId = typeof fromRecord.id === 'number' ? String(fromRecord.id) : chatId
  return {
    cursorId: updateId,
    message: {
      seq: typeof item.message_id === 'number' ? item.message_id : 0,
      messageId: typeof item.message_id === 'number' ? item.message_id : 0,
      fromUserId: chatId,
      toUserId: fromId,
      createdAt: typeof item.date === 'number' ? item.date * 1_000 : 0,
      items: itemsOf(item),
    },
  }
}

export class TelegramTransport {
  private readonly fetchImpl: typeof fetch
  private readonly apiBase: string
  private readonly pollTimeoutMs: number
  private readonly requestTimeoutMs: number

  constructor(options: TelegramTransportOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '')
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  private async call(
    token: string,
    method: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!tokenIsWellFormed(token)) {
      throw new ChannelAuthError('invalid-token', 'Bot Token 格式不正确')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.apiBase}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) throw new TelegramTransportError('timeout', 'Telegram 请求超时')
      throw new TelegramTransportError('network-error', '暂时无法访问 Telegram')
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    let parsed: TelegramResponse
    try {
      parsed = JSON.parse(text) as TelegramResponse
    } catch {
      throw new TelegramTransportError('invalid-response', 'Telegram 返回了无法解析的响应', {
        status: response.status,
      })
    }
    if (parsed.ok === true) return parsed.result

    const status = parsed.error_code ?? response.status
    const retryAfter = parsed.parameters?.retry_after
    if (status === 401 || status === 403) {
      throw new ChannelAuthError('unauthorized', 'Bot Token 无效或已被撤销，请重新填写')
    }
    if (status === 409) {
      throw new ChannelAuthError('conflict', '这个 Bot 已在别处轮询，请先停掉另一个实例')
    }
    if (status === 429) {
      throw new TelegramTransportError('rate-limited', 'Telegram 请求过于频繁', {
        status,
        ...(typeof retryAfter === 'number' ? { retryAfterMs: retryAfter * 1_000 } : {}),
      })
    }
    throw new TelegramTransportError('rejected', parsed.description ?? 'Telegram 拒绝了请求', { status })
  }

  /** Confirm the token and learn the bot identity. */
  async validate(credentials: TelegramCredentials): Promise<{ id: string; username?: string }> {
    const result = await this.call(credentials.token, 'getMe', {}, this.requestTimeoutMs)
    const record = result !== null && typeof result === 'object' ? result as Record<string, unknown> : {}
    const id = typeof record.id === 'number' ? String(record.id) : undefined
    if (id === undefined) throw new TelegramTransportError('invalid-response', 'Telegram 没有返回 Bot 身份')
    return {
      id,
      ...(typeof record.username === 'string' && record.username !== '' ? { username: record.username } : {}),
    }
  }

  /** Long poll. The cursor is the next update_offset; empty starts from now. */
  async getUpdates(credentials: TelegramCredentials, cursor = ''): Promise<UpdatesPage> {
    const body: Record<string, unknown> = {
      timeout: LONG_POLL_SECONDS,
      allowed_updates: ['message'],
    }
    if (cursor !== '') body.offset = Number(cursor)
    const result = await this.call(credentials.token, 'getUpdates', body, this.pollTimeoutMs)
    const updates = Array.isArray(result) ? result : []
    const messages = []
    let next = cursor === '' ? 0 : Number(cursor)
    for (const update of updates) {
      const parsed = parseUpdate(update)
      next = Math.max(next, parsed.cursorId + 1)
      if (parsed.message !== undefined) messages.push(parsed.message)
    }
    return { cursor: next === 0 ? cursor : String(next), messages }
  }

  async sendText(credentials: TelegramCredentials, chatId: string, text: string): Promise<number> {
    if (chatId === '') throw new TelegramTransportError('invalid-recipient', '缺少接收者')
    if (text.trim() === '') throw new TelegramTransportError('empty-text', '要发送的文本为空')
    const result = await this.call(credentials.token, 'sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }, this.requestTimeoutMs)
    const record = result !== null && typeof result === 'object' ? result as Record<string, unknown> : {}
    return typeof record.message_id === 'number' ? record.message_id : 0
  }
}
