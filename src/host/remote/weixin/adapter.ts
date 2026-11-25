import type { BindingStore, RemoteChannel } from '../bindings.ts'
import type { RemoteController } from '../controller.ts'
import { splitForChannel } from '../render.ts'
import type { ChannelCapabilities } from '../types.ts'
import { WeixinTransportError } from './transport.ts'
import type { InboundMessage, UpdatesPage, WeixinCredentials } from './transport.ts'

export interface WeixinTransportLike {
  getUpdates(credentials: WeixinCredentials, cursor?: string): Promise<UpdatesPage>
  sendText(
    credentials: WeixinCredentials,
    toUserId: string,
    text: string,
    options?: { readonly contextToken?: string },
  ): Promise<number>
}

export interface WeixinCursor {
  get(): string
  set(next: string): void
}

export interface WeixinAdapterOptions {
  readonly transport: WeixinTransportLike
  readonly controller: RemoteController
  readonly bindings: BindingStore
  readonly credentials: WeixinCredentials
  readonly capabilities: ChannelCapabilities
  readonly channel?: RemoteChannel
  readonly cursor?: WeixinCursor
  readonly sleep?: (ms: number) => Promise<void>
  readonly onFatal?: (error: unknown) => void
  readonly onError?: (error: unknown) => void
}

const RETRY_DELAYS_MS = [250, 1_000, 3_000, 5_000, 10_000, 30_000] as const
const DEFAULT_SLEEP = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const UNBOUND_HINT = '这台聊天还没绑定。请在电脑上打开「设置 → 远程连接」生成绑定码，然后把 6 位数字发给我。'
const BAD_CODE_HINT = '绑定码无效或已过期。请在电脑上重新生成一个。'
const UNSUPPORTED_HINT = '目前只支持文字和语音。图片和文件请在电脑上查看。'

function messageText(message: InboundMessage): string | undefined {
  for (const item of message.items) {
    if (item.kind === 'text' && item.text.trim() !== '') return item.text
  }
  for (const item of message.items) {
    if (item.kind === 'voice' && item.text !== undefined && item.text.trim() !== '') return item.text
  }
  return undefined
}

/**
 * WeChat private-chat loop: poll, bind, execute, reply.
 *
 * The adapter is deliberately thin. Binding state and command semantics live in
 * their own units; this class only moves messages and enforces the two rules a
 * chat surface needs: unbound chats may only redeem a code, and replies are
 * chunked to the channel's readability budget.
 */
export class WeixinAdapter {
  private stopped = false
  private readonly channel: RemoteChannel
  private readonly sleep: (ms: number) => Promise<void>
  private readonly cursor: WeixinCursor

  constructor(private readonly options: WeixinAdapterOptions) {
    this.channel = options.channel ?? 'weixin'
    this.sleep = options.sleep ?? DEFAULT_SLEEP
    let current = ''
    this.cursor = options.cursor ?? {
      get: () => current,
      set: next => {
        current = next
      },
    }
  }

  stop(): void {
    this.stopped = true
  }

  get running(): boolean {
    return !this.stopped
  }

  async run(): Promise<void> {
    let failures = 0
    while (!this.stopped) {
      let page: UpdatesPage
      try {
        page = await this.options.transport.getUpdates(this.options.credentials, this.cursor.get())
      } catch (error) {
        if (error instanceof WeixinTransportError && error.code === 'stale-token') {
          this.stopped = true
          this.options.onFatal?.(error)
          return
        }
        this.options.onError?.(error)
        const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)] ?? 30_000
        failures += 1
        await this.sleep(delay)
        continue
      }
      failures = 0
      this.cursor.set(page.cursor)
      for (const message of page.messages) {
        if (this.stopped) break
        try {
          await this.handle(message)
        } catch (error) {
          this.options.onError?.(error)
        }
      }
    }
  }

  private async handle(message: InboundMessage): Promise<void> {
    const chatId = message.fromUserId
    const text = messageText(message)
    if (text === undefined) {
      await this.reply(chatId, UNSUPPORTED_HINT, message.contextToken)
      return
    }

    if (!this.options.bindings.isBound(chatId)) {
      const candidate = text.trim()
      if (/^\d{6}$/.test(candidate)) {
        const bound = this.options.bindings.redeem(candidate, chatId, this.channel)
        await this.reply(chatId, bound ? '已绑定。回「任务」查看当前任务。' : BAD_CODE_HINT, message.contextToken)
        return
      }
      await this.reply(chatId, UNBOUND_HINT, message.contextToken)
      return
    }

    const reply = await this.options.controller.execute(chatId, text, this.options.capabilities)
    await this.reply(chatId, reply.text, message.contextToken)
  }

  private async reply(chatId: string, text: string, contextToken?: string): Promise<void> {
    const chunks = splitForChannel(text, this.options.capabilities.maxChars)
    for (const chunk of chunks) {
      await this.options.transport.sendText(
        this.options.credentials,
        chatId,
        chunk,
        contextToken === undefined ? {} : { contextToken },
      )
    }
  }
}
