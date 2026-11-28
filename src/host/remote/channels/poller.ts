import type { BindingStore, RemoteChannel } from '../bindings.ts'
import type { RemoteController } from '../controller.ts'
import { splitForChannel } from '../render.ts'
import type { ChannelCapabilities } from '../types.ts'
import { ChannelAuthError } from './types.ts'
import type { ChannelTransport, InboundMessage } from './types.ts'

export interface ChannelCursor {
  get(): string
  set(next: string): void
}

export interface ChannelHints {
  readonly unbound: string
  readonly badCode: string
  readonly unsupported: string
  readonly bound: string
}

export interface ChannelPollerOptions {
  readonly channel: RemoteChannel
  readonly transport: ChannelTransport
  readonly controller: RemoteController
  readonly bindings: BindingStore
  readonly capabilities: ChannelCapabilities
  readonly cursor?: ChannelCursor
  readonly sleep?: (ms: number) => Promise<void>
  readonly onFatal?: (error: unknown) => void
  readonly onError?: (error: unknown) => void
  /** Re-read the host session list before a command; the index warms up late. */
  readonly refresh?: () => Promise<unknown>
  /** Pause between empty pages; the real long poll already held for ~35s. */
  readonly emptyPageDelayMs?: number
  /** Called for every inbound message so a channel can track freshness. */
  readonly onInbound?: () => void
  /** A failure that retrying cannot fix (revoked token, logged out). */
  readonly isFatal?: (error: unknown) => boolean
  readonly hints?: Partial<ChannelHints>
}

const RETRY_DELAYS_MS = [250, 1_000, 3_000, 5_000, 10_000, 30_000] as const
const DEFAULT_SLEEP = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const DEFAULT_HINTS: ChannelHints = {
  unbound: '这台聊天还没绑定。请在电脑上打开「设置 → 智能体增强 → 远程连接」生成绑定码，然后把 6 位数字发给我。',
  badCode: '绑定码无效、已过期，或不属于这个平台。请在电脑上重新生成一个。',
  unsupported: '目前只支持文字和语音。图片和文件请在电脑上查看。',
  bound: '已绑定。回「任务」查看当前任务。',
}

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
 * One polling channel: poll, bind, execute, reply.
 *
 * All platforms share this loop. The transport owns credentials, protocol and
 * message mapping; the poller only enforces the rules a chat surface needs:
 * an unbound chat may only redeem a code issued for this channel, replies are
 * chunked, and a fatal auth error stops instead of spinning.
 */
export class ChannelPoller {
  private stopped = false
  private readonly contexts = new Map<string, string>()
  private readonly sleep: (ms: number) => Promise<void>
  private readonly cursor: ChannelCursor
  private readonly hints: ChannelHints

  constructor(private readonly options: ChannelPollerOptions) {
    this.sleep = options.sleep ?? DEFAULT_SLEEP
    this.hints = { ...DEFAULT_HINTS, ...options.hints }
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

  /** Latest inbound context token, so a push can answer in the same thread. */
  contextFor(chatId: string): string | undefined {
    return this.contexts.get(chatId)
  }

  async run(): Promise<void> {
    let failures = 0
    while (!this.stopped) {
      let page
      try {
        page = await this.options.transport.getUpdates(this.cursor.get())
      } catch (error) {
        if (this.options.isFatal?.(error) === true || error instanceof ChannelAuthError) {
          this.stopped = true
          this.options.onFatal?.(error)
          return
        }
        this.options.onError?.(error)
        const retryAfter = (error as { readonly retryAfterMs?: unknown }).retryAfterMs
        const delay = typeof retryAfter === 'number' && retryAfter > 0
          ? retryAfter
          : RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)] ?? 30_000
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
        } finally {
          // Telegram spins a tapped button until this call arrives.
          if (message.callbackQueryId !== undefined) {
            try {
              await this.options.transport.acknowledge?.(message.callbackQueryId)
            } catch (error) {
              this.options.onError?.(error)
            }
          }
        }
      }
      if (page.messages.length === 0 && !this.stopped) {
        await this.sleep(this.options.emptyPageDelayMs ?? 1_000)
      }
    }
  }

  private async handle(message: InboundMessage): Promise<void> {
    this.options.onInbound?.()
    const chatId = message.fromUserId
    if (message.contextToken !== undefined && message.contextToken !== '') {
      this.contexts.set(chatId, message.contextToken)
    }
    const text = messageText(message)
    if (text === undefined) {
      await this.reply(chatId, this.hints.unsupported, message.contextToken)
      return
    }

    if (!this.options.bindings.isBound(chatId)) {
      const candidate = text.trim()
      if (/^\d{6}$/.test(candidate)) {
        const bound = this.options.bindings.redeem(candidate, chatId, this.options.channel)
        await this.reply(chatId, bound ? this.hints.bound : this.hints.badCode, message.contextToken)
        return
      }
      await this.reply(chatId, this.hints.unbound, message.contextToken)
      return
    }

    try {
      await this.options.refresh?.()
    } catch (error) {
      this.options.onError?.(error)
    }
    const reply = await this.options.controller.execute(chatId, text, this.options.capabilities)
    // Follow the chat's choice across replies and restarts.
    this.options.bindings.setFocus(chatId, this.options.controller.focus(chatId))
    await this.reply(chatId, reply.text, message.contextToken, reply.buttons)
  }

  private async reply(
    chatId: string,
    text: string,
    contextToken?: string,
    buttons?: readonly { readonly label: string; readonly command: string }[],
  ): Promise<void> {
    const chunks = splitForChannel(text, this.options.capabilities.maxChars)
    for (const [index, chunk] of chunks.entries()) {
      await this.options.transport.sendText(
        chatId,
        chunk,
        {
          ...(contextToken === undefined ? {} : { contextToken }),
          ...(index === chunks.length - 1 && buttons !== undefined && buttons.length > 0
            ? { buttons }
            : {}),
        },
      )
    }
  }
}
