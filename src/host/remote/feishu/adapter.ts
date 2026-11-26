import type { BindingStore } from '../bindings.ts'
import { ChannelPoller } from '../channels/poller.ts'
import type { ChannelCursor } from '../channels/poller.ts'
import type { RemoteController } from '../controller.ts'
import type { ChannelCapabilities } from '../types.ts'
import { FeishuTransport } from './transport.ts'
import type { FeishuCredentials } from './transport.ts'

export interface FeishuAdapterOptions {
  readonly transport: FeishuTransport
  readonly credentials: FeishuCredentials
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

const FEISHU_HINTS = {
  unbound: '这个飞书聊天还没绑定。请在电脑上打开「设置 → 智能体增强 → 远程连接」的飞书渠道生成绑定码，然后把 6 位数字发给我。',
  badCode: '绑定码无效、已过期，或不是飞书渠道的。请重新生成一个。',
  unsupported: '目前只支持文字。语音、图片和文件请在电脑上查看。',
  bound: '已绑定。回「任务」查看当前任务。',
}

/** Feishu channel: same poller, Feishu transport (WebSocket events + HTTP sends). */
export class FeishuAdapter {
  private readonly poller: ChannelPoller

  constructor(options: FeishuAdapterOptions) {
    this.poller = new ChannelPoller({
      channel: 'feishu',
      transport: {
        getUpdates: cursor => options.transport.getUpdates(cursor),
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
      hints: FEISHU_HINTS,
    })
  }

  stop(): void {
    this.poller.stop()
  }

  get running(): boolean {
    return this.poller.running
  }

  run(): Promise<void> {
    return this.poller.run()
  }
}
