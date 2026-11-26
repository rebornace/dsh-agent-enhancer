import type { BindingStore } from '../bindings.ts'
import { ChannelPoller } from '../channels/poller.ts'
import type { ChannelCursor } from '../channels/poller.ts'
import type { RemoteController } from '../controller.ts'
import type { ChannelCapabilities } from '../types.ts'
import { TelegramTransport } from './transport.ts'
import type { TelegramCredentials } from './transport.ts'

export interface TelegramAdapterOptions {
  readonly transport: TelegramTransport
  readonly credentials: TelegramCredentials
  readonly controller: RemoteController
  readonly bindings: BindingStore
  readonly capabilities: ChannelCapabilities
  readonly cursor?: ChannelCursor
  readonly sleep?: (ms: number) => Promise<void>
  readonly onFatal?: (error: unknown) => void
  readonly onError?: (error: unknown) => void
  readonly refresh?: () => Promise<unknown>
  readonly emptyPageDelayMs?: number
}

const TELEGRAM_HINTS = {
  unbound: '这个 Telegram 聊天还没绑定。请在电脑上打开「设置 → 智能体增强 → 远程连接」的 Telegram 渠道生成绑定码，然后把 6 位数字发给我。',
  badCode: '绑定码无效、已过期，或不是 Telegram 渠道的。请重新生成一个。',
  unsupported: '目前只支持文字。语音、图片和文件请在电脑上查看。',
  bound: '已绑定。回「任务」查看当前任务。',
}

/** Telegram channel: same poller, Telegram transport. */
export class TelegramAdapter {
  private readonly poller: ChannelPoller

  constructor(options: TelegramAdapterOptions) {
    this.poller = new ChannelPoller({
      channel: 'telegram',
      transport: {
        getUpdates: cursor => options.transport.getUpdates(options.credentials, cursor),
        sendText: (chatId, text, sendOptions) => options.transport.sendText(
          options.credentials,
          chatId,
          text,
          sendOptions,
        ),
        acknowledge: callbackQueryId => options.transport.answerCallbackQuery(
          options.credentials,
          callbackQueryId,
        ),
      },
      controller: options.controller,
      bindings: options.bindings,
      capabilities: options.capabilities,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.onFatal === undefined ? {} : { onFatal: options.onFatal }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
      ...(options.emptyPageDelayMs === undefined ? {} : { emptyPageDelayMs: options.emptyPageDelayMs }),
      hints: TELEGRAM_HINTS,
    })
  }

  stop(): void {
    this.poller.stop()
  }

  get running(): boolean {
    return this.poller.running
  }

  contextFor(chatId: string): string | undefined {
    return this.poller.contextFor(chatId)
  }

  run(): Promise<void> {
    return this.poller.run()
  }
}
