import { ChannelAuthError } from '../channels/types.ts'
import type { InboundItem, InboundMessage, UpdatesPage } from '../channels/types.ts'

/**
 * Feishu (Lark) bot transport.
 *
 * Two halves of one bot: the HTTP side sends messages and reads the bot
 * identity, the WebSocket side ("长连接") receives events without a public
 * address. Events are queued here and drained by the shared channel poller, so
 * Feishu reuses the same binding and command rules as every other channel.
 *
 * The WebSocket protocol is protobuf-framed, so the official SDK does that one
 * job and is imported lazily: a host that never connects Feishu never loads it,
 * and tests inject a fake loader instead of the real socket.
 */

export interface FeishuCredentials {
  readonly appId: string
  readonly appSecret: string
  /** Bot display name learned at connect time. */
  readonly name?: string
}

export class FeishuTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: { readonly status?: number; readonly retryAfterMs?: number } = {},
  ) {
    super(message)
    this.name = 'FeishuTransportError'
  }
}

/** Minimal structural view of the SDK pieces we use. */
export interface FeishuSocket {
  start(params: { eventDispatcher: FeishuDispatcher }): Promise<void>
  close(params?: { force?: boolean }): void
}

export interface FeishuDispatcher {
  register(handles: Record<string, (data: unknown) => unknown>): unknown
}

export interface FeishuSdk {
  readonly WSClient: new (params: {
    readonly appId: string
    readonly appSecret: string
    readonly autoReconnect?: boolean
    readonly loggerLevel?: number
    readonly onError?: (error: Error) => void
    readonly onReady?: () => void
  }) => FeishuSocket
  readonly EventDispatcher: new (params: { readonly loggerLevel?: number }) => FeishuDispatcher
  readonly LoggerLevel?: { readonly error?: number }
}

export interface FeishuTransportOptions {
  readonly fetchImpl?: typeof fetch
  readonly apiBase?: string
  readonly requestTimeoutMs?: number
  /** How long one `getUpdates` waits for a pushed event before returning empty. */
  readonly waitTimeoutMs?: number
  readonly loadSdk?: () => Promise<FeishuSdk>
}

const DEFAULT_API_BASE = 'https://open.feishu.cn'
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_WAIT_TIMEOUT_MS = 20_000
const SEEN_LIMIT = 200

/** Feishu auth/permission codes that retrying cannot fix. */
const AUTH_CODES = new Set([99991661, 99991663, 99991668, 10003, 10014])

interface FeishuResponse {
  readonly code?: number
  readonly msg?: string
  readonly tenant_access_token?: string
  readonly expire?: number
  readonly bot?: { readonly app_name?: string }
  readonly data?: { readonly message_id?: string }
}

function sdkLoader(): Promise<FeishuSdk> {
  return import('@larksuiteoapi/node-sdk').then(module => module as unknown as FeishuSdk)
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function textItems(messageType: string, content: string): InboundItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content) as unknown
  } catch {
    return [{ kind: 'other' }]
  }
  if (parsed === null || typeof parsed !== 'object') return [{ kind: 'other' }]
  if (messageType === 'text') {
    const text = textOf((parsed as { text?: unknown }).text)
    return text === undefined ? [{ kind: 'other' }] : [{ kind: 'text', text }]
  }
  if (messageType === 'post') {
    const record = parsed as { title?: unknown; content?: unknown }
    const lines: string[] = []
    const title = textOf(record.title)
    if (title !== undefined) lines.push(title)
    if (Array.isArray(record.content)) {
      for (const paragraph of record.content) {
        if (!Array.isArray(paragraph)) continue
        const pieces: string[] = []
        for (const element of paragraph) {
          if (element === null || typeof element !== 'object') continue
          const text = textOf((element as { text?: unknown }).text)
          if (text !== undefined) pieces.push(text)
        }
        if (pieces.length > 0) lines.push(pieces.join(''))
      }
    }
    const text = lines.join('\n').trim()
    return text === '' ? [{ kind: 'other' }] : [{ kind: 'text', text }]
  }
  if (messageType === 'audio') return [{ kind: 'voice' }]
  if (messageType === 'image') return [{ kind: 'image' }]
  if (messageType === 'file' || messageType === 'media') return [{ kind: 'file' }]
  return [{ kind: 'other' }]
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

/** One `im.message.receive_v1` event; bot DMs only, like the other channels. */
export function parseMessageEvent(data: unknown): InboundMessage | undefined {
  const root = recordOf(data)
  if (root === undefined) return undefined
  const sender = recordOf(root.sender)
  if (sender?.sender_type === 'app') return undefined
  const message = recordOf(root.message)
  if (message === undefined) return undefined
  // A bound group would let every member control the desktop.
  if (message.chat_type !== 'p2p') return undefined
  const chatId = textOf(message.chat_id)
  const messageId = textOf(message.message_id)
  if (chatId === undefined) return undefined
  const messageType = typeof message.message_type === 'string' ? message.message_type : 'unknown'
  const content = typeof message.content === 'string' ? message.content : ''
  const senderId = recordOf(sender?.sender_id)
  const created = Number(message.create_time)
  return {
    seq: 0,
    messageId: 0,
    fromUserId: chatId,
    toUserId: textOf(senderId?.open_id) ?? '',
    createdAt: Number.isFinite(created) && created > 0 ? created : Date.now(),
    items: textItems(messageType, content),
    ...(messageId === undefined ? {} : { contextToken: messageId }),
  }
}

/** One `card.action.trigger` event: the tapped button's command. */
export function parseCardAction(data: unknown): InboundMessage | undefined {
  const root = recordOf(data)
  if (root === undefined) return undefined
  const context = recordOf(root.context)
  const chatId = textOf(context?.open_chat_id) ?? textOf(root.open_chat_id)
  const action = recordOf(root.action)
  const value = recordOf(action?.value)
  const command = textOf(value?.command)
  if (chatId === undefined || command === undefined) return undefined
  const operator = recordOf(root.operator)
  return {
    seq: 0,
    messageId: 0,
    fromUserId: chatId,
    toUserId: textOf(operator?.open_id) ?? '',
    createdAt: Date.now(),
    items: [{ kind: 'text', text: command }],
  }
}

export class FeishuTransport {
  private readonly fetchImpl: typeof fetch
  private readonly apiBase: string
  private readonly requestTimeoutMs: number
  private readonly waitTimeoutMs: number
  private readonly loadSdk: () => Promise<FeishuSdk>
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>()
  private readonly queue: InboundMessage[] = []
  private readonly seen = new Set<string>()
  private socket: FeishuSocket | undefined
  private socketError: string | undefined
  private waiter: (() => void) | undefined

  constructor(options: FeishuTransportOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '')
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    this.loadSdk = options.loadSdk ?? sdkLoader
  }

  get lastSocketError(): string | undefined {
    return this.socketError
  }

  private async call(
    path: string,
    init: { method: 'GET' | 'POST'; token?: string; body?: unknown },
  ): Promise<FeishuResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method: init.method,
        headers: {
          'content-type': 'application/json',
          ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      })
    } catch {
      if (controller.signal.aborted) throw new FeishuTransportError('timeout', '飞书请求超时')
      throw new FeishuTransportError('network-error', '暂时无法访问飞书')
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    let parsed: FeishuResponse
    try {
      parsed = JSON.parse(text) as FeishuResponse
    } catch {
      throw new FeishuTransportError('invalid-response', '飞书返回了无法解析的响应', {
        status: response.status,
      })
    }
    if (response.status === 401 || (typeof parsed.code === 'number' && AUTH_CODES.has(parsed.code))) {
      throw new ChannelAuthError('unauthorized', '飞书 App ID 或 App Secret 无效，或应用已停用')
    }
    if (response.status === 429 || parsed.code === 99991400) {
      throw new FeishuTransportError('rate-limited', '飞书请求过于频繁', {
        status: response.status,
        retryAfterMs: 2_000,
      })
    }
    if (parsed.code !== undefined && parsed.code !== 0) {
      throw new FeishuTransportError(
        'rejected',
        parsed.msg === undefined || parsed.msg === '' ? `飞书拒绝了请求（${parsed.code}）` : parsed.msg,
        { status: response.status },
      )
    }
    if (!response.ok) {
      throw new FeishuTransportError('rejected', `飞书请求失败（HTTP ${response.status}）`, {
        status: response.status,
      })
    }
    return parsed
  }

  private async tenantToken(credentials: FeishuCredentials): Promise<string> {
    const key = `${credentials.appId}\n${credentials.appSecret}`
    const cached = this.tokens.get(key)
    if (cached !== undefined && cached.expiresAt > Date.now() + 60_000) return cached.token
    const response = await this.call('/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      body: { app_id: credentials.appId, app_secret: credentials.appSecret },
    })
    const token = response.tenant_access_token
    if (token === undefined || token === '') {
      throw new FeishuTransportError('invalid-response', '飞书没有返回 tenant_access_token')
    }
    const expire = typeof response.expire === 'number' && response.expire > 0 ? response.expire : 7_200
    this.tokens.set(key, { token, expiresAt: Date.now() + expire * 1_000 })
    return token
  }

  /** Confirm the credentials and learn the bot name. */
  async validate(credentials: FeishuCredentials): Promise<{ name?: string }> {
    const token = await this.tenantToken(credentials)
    const info = await this.call('/open-apis/bot/v3/info', { method: 'GET', token })
    const name = textOf(info.bot?.app_name)
    return name === undefined ? {} : { name }
  }

  /**
   * Open the long connection. Events arrive on the SDK's socket and wait in the
   * queue for `getUpdates`.
   */
  async start(credentials: FeishuCredentials): Promise<void> {
    if (this.socket !== undefined) return
    const sdk = await this.loadSdk()
    const loggerLevel = sdk.LoggerLevel?.error
    const dispatcher = new sdk.EventDispatcher(
      loggerLevel === undefined ? {} : { loggerLevel },
    )
    dispatcher.register({
      'im.message.receive_v1': (data: unknown) => {
        const message = parseMessageEvent(data)
        if (message !== undefined) this.push(message)
        return undefined
      },
      'card.action.trigger': (data: unknown) => {
        const message = parseCardAction(data)
        if (message !== undefined) this.push(message)
        // The socket response answers the tap; the command is handled by the poller.
        return { toast: { type: 'info', content: '已收到' } }
      },
    })
    const socket = new sdk.WSClient({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      autoReconnect: true,
      ...(loggerLevel === undefined ? {} : { loggerLevel }),
      onReady: () => {
        this.socketError = undefined
      },
      onError: (error: Error) => {
        this.socketError = error.message
      },
    })
    this.socket = socket
    try {
      await socket.start({ eventDispatcher: dispatcher })
    } catch (error) {
      if (this.socket === socket) this.socket = undefined
      socket.close({ force: true })
      throw error
    }
  }

  stop(): void {
    const socket = this.socket
    this.socket = undefined
    // A long connection has no replay: drop whatever was queued for the old one.
    this.queue.length = 0
    this.wake()
    if (socket !== undefined) {
      try {
        socket.close({ force: true })
      } catch {
        // A socket that already died has nothing left to close.
      }
    }
  }

  private push(message: InboundMessage): void {
    // Message ids are stable across reconnects; a card tap has none and must
    // never be collapsed with an identical earlier tap.
    const key = message.contextToken
    if (key !== undefined) {
      if (this.seen.has(key)) return
      this.seen.add(key)
      if (this.seen.size > SEEN_LIMIT) {
        const oldest = this.seen.values().next().value
        if (oldest !== undefined) this.seen.delete(oldest)
      }
    }
    this.queue.push(message)
    this.wake()
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.waiter === wake) this.waiter = undefined
        resolve()
      }, ms)
      const wake = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.waiter = wake
    })
  }

  /** Push channels have no cursor; keep the empty string so the poller is happy. */
  async getUpdates(cursor = ''): Promise<UpdatesPage> {
    if (this.queue.length === 0) await this.wait(this.waitTimeoutMs)
    if (this.queue.length === 0) return { cursor, messages: [] }
    return { cursor, messages: this.queue.splice(0, this.queue.length) }
  }

  async sendText(
    credentials: FeishuCredentials,
    chatId: string,
    text: string,
    options: { readonly buttons?: readonly { readonly label: string; readonly command: string }[] } = {},
  ): Promise<string> {
    if (chatId === '') throw new FeishuTransportError('invalid-recipient', '缺少接收者')
    if (text.trim() === '') throw new FeishuTransportError('empty-text', '要发送的文本为空')
    const buttons = options.buttons ?? []
    const token = await this.tenantToken(credentials)
    let msgType = 'text'
    let content = JSON.stringify({ text })
    if (buttons.length > 0) {
      msgType = 'interactive'
      content = JSON.stringify({
        config: { wide_screen_mode: true },
        elements: [
          { tag: 'div', text: { tag: 'plain_text', content: text } },
          {
            tag: 'action',
            actions: buttons.map(button => ({
              tag: 'button',
              text: { tag: 'plain_text', content: button.label },
              type: 'default',
              value: { command: button.command },
            })),
          },
        ],
      })
    }
    const response = await this.call(
      `/open-apis/im/v1/messages?receive_id_type=chat_id`,
      {
        method: 'POST',
        token,
        body: { receive_id: chatId, msg_type: msgType, content },
      },
    )
    return response.data?.message_id ?? ''
  }
}
