import type { BindingStore, RemoteChannel } from '../bindings.ts'
import { ChannelPoller } from '../channels/poller.ts'
import type { ChannelCursor } from '../channels/poller.ts'
import type { RemoteController } from '../controller.ts'
import type { ChannelCapabilities } from '../types.ts'
import type { UpdatesPage, WeixinCredentials } from './transport.ts'
import { WeixinTransportError } from './transport.ts'

export interface WeixinTransportLike {
  getUpdates(credentials: WeixinCredentials, cursor?: string): Promise<UpdatesPage>
  sendText(
    credentials: WeixinCredentials,
    toUserId: string,
    text: string,
    options?: { readonly contextToken?: string },
  ): Promise<number>
}

export interface WeixinCursor extends ChannelCursor {}

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
  /** Re-read the host session list before a command; the index warms up late. */
  readonly refresh?: () => Promise<unknown>
  /** Pause between empty pages; the real long poll already held for ~35s. */
  readonly emptyPageDelayMs?: number
  readonly onInbound?: () => void
}

const WEIXIN_HINTS = {
  unbound: '这台聊天还没绑定。请在电脑上打开「设置 → 远程连接」生成绑定码，然后把 6 位数字发给我。',
  badCode: '绑定码无效或已过期。请在电脑上重新生成一个。',
  unsupported: '目前只支持文字和语音。图片和文件请在电脑上查看。',
  bound: '已绑定。回「任务」查看当前任务。',
}

/** WeChat channel: thin wrapper that binds credentials into the shared poller. */
export class WeixinAdapter {
  private readonly poller: ChannelPoller

  constructor(options: WeixinAdapterOptions) {
    this.poller = new ChannelPoller({
      channel: options.channel ?? 'weixin',
      transport: {
        getUpdates: cursor => options.transport.getUpdates(options.credentials, cursor),
        sendText: (chatId, text, sendOptions) => options.transport.sendText(
          options.credentials,
          chatId,
          text,
          sendOptions,
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
      isFatal: error => error instanceof WeixinTransportError && error.code === 'stale-token',
      ...(options.onInbound === undefined ? {} : { onInbound: options.onInbound }),
      hints: WEIXIN_HINTS,
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
