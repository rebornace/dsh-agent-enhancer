import { randomBytes, randomUUID } from 'node:crypto'

/**
 * WeChat iLink transport.
 *
 * Facts and shapes verified against real frames (2026-11-25) and the MIT
 * Tencent implementation. This module moves bytes only: no task model, no
 * rendering, no binding. All calls are allowlisted to WeChat hosts because the
 * bearer token must never be sent anywhere else.
 */

export class WeixinTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: { readonly status?: number; readonly providerCode?: string } = {},
  ) {
    super(message)
    this.name = 'WeixinTransportError'
  }
}

export type LoginStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect'
  | (string & {})

export interface LoginTicket {
  /** Ticket used by the status poll; the QR payload is `qrUrl`. */
  readonly ticket: string
  /** Encode this URL into a QR code; do not open it and scan the page's own QR. */
  readonly qrUrl: string
}

export interface WeixinCredentials {
  readonly baseUrl: string
  readonly token: string
  readonly botId?: string
  readonly userId?: string
}

export interface LoginPoll {
  readonly status: LoginStatus
  readonly credentials?: WeixinCredentials
}

export type InboundItem =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'voice'; readonly text?: string }
  | { readonly kind: 'image' }
  | { readonly kind: 'file' }
  | { readonly kind: 'other' }

export interface InboundMessage {
  readonly seq: number
  readonly messageId: number
  readonly fromUserId: string
  readonly toUserId: string
  readonly createdAt: number
  readonly items: readonly InboundItem[]
  readonly contextToken?: string
}

export interface UpdatesPage {
  readonly cursor: string
  readonly messages: readonly InboundMessage[]
}

export interface SendTextOptions {
  readonly contextToken?: string
  readonly runId?: string
  readonly clientId?: string
}

export interface WeixinTransportOptions {
  readonly fetchImpl?: typeof fetch
  readonly loginBaseUrl?: string
  readonly pollTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly channelVersion?: string
  readonly botAgent?: string
}

const DEFAULT_LOGIN_BASE_URL = 'https://ilinkai.weixin.qq.com/'
const PROTOCOL_VERSION = '2.4.6'
const BOT_TYPE = '3'
const APP_ID = 'bot'
const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6) // 2.4.6
const DEFAULT_POLL_TIMEOUT_MS = 35_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

function isWeixinHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com')
    || host === 'wechat.com' || host.endsWith('.wechat.com')
}

function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new WeixinTransportError('invalid-base-url', '微信服务返回了无效的连接地址')
  }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname) || (url.port !== '' && url.port !== '443')) {
    throw new WeixinTransportError('untrusted-base-url', '微信服务返回了不受信任的连接地址')
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

function normalizeQrUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new WeixinTransportError('invalid-qr', '微信服务返回了无效的扫码地址')
  }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname)) {
    throw new WeixinTransportError('untrusted-qr', '微信服务返回了不受信任的扫码地址')
  }
  return url.toString()
}

function providerCodeOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  for (const key of ['ret', 'errcode'] as const) {
    const raw = (value as Record<string, unknown>)[key]
    if (typeof raw === 'number' && raw !== 0) return String(raw)
    if (typeof raw === 'string' && raw !== '' && raw !== '0') return raw
  }
  return undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function textOfItem(item: Record<string, unknown>): string | undefined {
  const textItem = item.text_item
  if (textItem === null || typeof textItem !== 'object') return undefined
  return nonEmptyString((textItem as { text?: unknown }).text) ?? ''
}

function voiceTextOfItem(item: Record<string, unknown>): string | undefined {
  const voiceItem = item.voice_item
  if (voiceItem === null || typeof voiceItem !== 'object') return undefined
  return nonEmptyString((voiceItem as { text?: unknown }).text)
}

function parseItems(raw: unknown): InboundItem[] {
  if (!Array.isArray(raw)) return []
  const items: InboundItem[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    switch (item.type) {
      case 1: {
        const text = textOfItem(item)
        items.push(text === undefined ? { kind: 'other' } : { kind: 'text', text })
        break
      }
      case 3: {
        const text = voiceTextOfItem(item)
        items.push(text === undefined ? { kind: 'voice' } : { kind: 'voice', text })
        break
      }
      case 2:
        items.push({ kind: 'image' })
        break
      case 4:
        items.push({ kind: 'file' })
        break
      default:
        items.push({ kind: 'other' })
    }
  }
  return items
}

function parseMessage(raw: unknown): InboundMessage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const fromUserId = nonEmptyString(record.from_user_id)
  if (fromUserId === undefined) return undefined
  const messageId = typeof record.message_id === 'number' ? record.message_id : 0
  const seq = typeof record.seq === 'number' ? record.seq : 0
  const createdAt = typeof record.create_time_ms === 'number' ? record.create_time_ms : 0
  const contextToken = nonEmptyString(record.context_token)
  return {
    seq,
    messageId,
    fromUserId,
    toUserId: nonEmptyString(record.to_user_id) ?? '',
    createdAt,
    items: parseItems(record.item_list),
    ...(contextToken === undefined ? {} : { contextToken }),
  }
}

export class WeixinTransport {
  private readonly fetchImpl: typeof fetch
  private readonly loginBaseUrl: string
  private readonly pollTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly channelVersion: string
  private readonly botAgent: string

  constructor(options: WeixinTransportOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.loginBaseUrl = normalizeBaseUrl(options.loginBaseUrl ?? DEFAULT_LOGIN_BASE_URL)
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.channelVersion = options.channelVersion ?? PROTOCOL_VERSION
    this.botAgent = options.botAgent ?? 'dsh-agent-enhancer'
  }

  private baseInfo(): { channel_version: string; bot_agent: string } {
    return { channel_version: this.channelVersion, bot_agent: this.botAgent }
  }

  private headers(token?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'iLink-App-Id': APP_ID,
      'iLink-App-ClientVersion': CLIENT_VERSION,
    }
    if (token === undefined) return headers
    // The protocol wants a random uint32 rendered as decimal, then base64.
    const uin = randomBytes(4).readUInt32BE(0)
    return {
      ...headers,
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${token}`,
      'X-WECHAT-UIN': Buffer.from(String(uin), 'utf8').toString('base64'),
    }
  }

  private async request(
    method: 'GET' | 'POST',
    baseUrl: string,
    endpoint: string,
    options: { readonly body?: unknown; readonly token?: string; readonly timeoutMs: number },
  ): Promise<unknown> {
    const base = normalizeBaseUrl(baseUrl)
    const url = new URL(endpoint, base)
    if (url.protocol !== 'https:' || !isWeixinHost(url.hostname)) {
      throw new WeixinTransportError('untrusted-endpoint', '拒绝访问不受信任的微信地址')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: this.headers(options.token),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        throw new WeixinTransportError('http-error', `微信服务请求失败（HTTP ${response.status}）`, { status: response.status })
      }
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new WeixinTransportError('invalid-response', '微信服务返回了无法解析的响应')
      }
    } catch (error) {
      if (error instanceof WeixinTransportError) throw error
      if (controller.signal.aborted) throw new WeixinTransportError('timeout', '微信服务请求超时')
      throw new WeixinTransportError('network-error', '暂时无法访问微信服务')
    } finally {
      clearTimeout(timer)
    }
  }

  /** Fresh login QR. The caller renders `qrUrl` as a QR code; the ticket polls status. */
  async beginLogin(localTokens: readonly string[] = []): Promise<LoginTicket> {
    const response = await this.request('POST', this.loginBaseUrl, `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, {
      body: { local_token_list: localTokens.slice(-10) },
      timeoutMs: this.requestTimeoutMs,
    })
    const record = response !== null && typeof response === 'object' ? response as Record<string, unknown> : {}
    const providerCode = providerCodeOf(record)
    if (providerCode !== undefined) {
      throw new WeixinTransportError('qr-rejected', '微信服务拒绝了二维码申请', { providerCode })
    }
    const ticket = nonEmptyString(record.qrcode)
    const qrUrl = nonEmptyString(record.qrcode_img_content)
    if (ticket === undefined || qrUrl === undefined) {
      throw new WeixinTransportError('invalid-qr', '微信服务没有返回有效的二维码')
    }
    return { ticket, qrUrl: normalizeQrUrl(qrUrl) }
  }

  async pollLogin(ticket: string, verifyCode?: string): Promise<LoginPoll> {
    const query = new URLSearchParams({ qrcode: ticket })
    if (verifyCode !== undefined && verifyCode !== '') query.set('verify_code', verifyCode)
    const response = await this.request('GET', this.loginBaseUrl, `ilink/bot/get_qrcode_status?${query.toString()}`, {
      timeoutMs: this.pollTimeoutMs,
    })
    const record = response !== null && typeof response === 'object' ? response as Record<string, unknown> : {}
    const status = nonEmptyString(record.status)
    if (status === undefined) {
      throw new WeixinTransportError('invalid-login-status', '微信服务返回了无法识别的扫码状态')
    }
    if (status !== 'confirmed') return { status }
    const baseUrl = nonEmptyString(record.baseurl)
    const token = nonEmptyString(record.bot_token)
    if (baseUrl === undefined || token === undefined) {
      throw new WeixinTransportError('invalid-credentials', '微信服务没有返回登录凭据')
    }
    return {
      status,
      credentials: {
        baseUrl: normalizeBaseUrl(baseUrl),
        token,
        ...(nonEmptyString(record.ilink_bot_id) === undefined ? {} : { botId: nonEmptyString(record.ilink_bot_id) }),
        ...(nonEmptyString(record.ilink_user_id) === undefined ? {} : { userId: nonEmptyString(record.ilink_user_id) }),
      },
    }
  }

  /**
   * Long poll. A client-side timeout is normal: it returns no messages and the
   * same cursor so the next round can continue.
   */
  async getUpdates(credentials: WeixinCredentials, cursor = ''): Promise<UpdatesPage> {
    let response: unknown
    try {
      response = await this.request('POST', credentials.baseUrl, 'ilink/bot/getupdates', {
        body: { get_updates_buf: cursor, base_info: this.baseInfo() },
        token: credentials.token,
        timeoutMs: this.pollTimeoutMs,
      })
    } catch (error) {
      if (error instanceof WeixinTransportError && error.code === 'timeout') {
        return { cursor, messages: [] }
      }
      throw error
    }
    const record = response !== null && typeof response === 'object' ? response as Record<string, unknown> : {}
    const providerCode = providerCodeOf(record)
    if (providerCode !== undefined) {
      throw new WeixinTransportError(providerCode === '-14' ? 'stale-token' : 'updates-rejected', '微信服务拒绝了消息拉取', { providerCode })
    }
    const messages: InboundMessage[] = []
    if (Array.isArray(record.msgs)) {
      for (const raw of record.msgs) {
        const message = parseMessage(raw)
        if (message !== undefined) messages.push(message)
      }
    }
    const next = nonEmptyString(record.get_updates_buf) ?? cursor
    return { cursor: next, messages }
  }

  /** Send one text message. Chunking belongs to the caller (it is a UI budget, not a protocol limit). */
  async sendText(credentials: WeixinCredentials, toUserId: string, text: string, options: SendTextOptions = {}): Promise<number> {
    if (toUserId === '') throw new WeixinTransportError('invalid-recipient', '缺少接收者')
    if (text.trim() === '') throw new WeixinTransportError('empty-text', '要发送的文本为空')
    const payload = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: options.clientId ?? `dsh-enhancer-${randomUUID()}`,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        ...(options.contextToken === undefined ? {} : { context_token: options.contextToken }),
        ...(options.runId === undefined ? {} : { run_id: options.runId }),
      },
      base_info: this.baseInfo(),
    }
    const response = await this.request('POST', credentials.baseUrl, 'ilink/bot/sendmessage', {
      body: payload,
      token: credentials.token,
      timeoutMs: this.requestTimeoutMs,
    })
    const record = response !== null && typeof response === 'object' ? response as Record<string, unknown> : {}
    const providerCode = providerCodeOf(record)
    if (providerCode !== undefined) {
      throw new WeixinTransportError('send-rejected', '微信服务拒绝了这条消息', { providerCode })
    }
    return typeof record.message_id === 'number' ? record.message_id : 0
  }
}
