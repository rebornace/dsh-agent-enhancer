import { describe, expect, it, vi } from 'vitest'
import { BindingStore } from '../src/host/remote/bindings.ts'
import { RemoteController } from '../src/host/remote/controller.ts'
import { TelegramAdapter } from '../src/host/remote/telegram/adapter.ts'
import type { TelegramTransport } from '../src/host/remote/telegram/transport.ts'
import type { InboundMessage, UpdatesPage } from '../src/host/remote/channels/types.ts'
import type { ChannelCapabilities } from '../src/host/remote/types.ts'

const textOnly: ChannelCapabilities = {
  buttons: false,
  editMessage: false,
  threads: false,
  media: 'none',
  markdown: false,
  maxChars: 4_000,
  privateOnly: true,
}

function message(text: string | undefined, options: { from?: string; voice?: boolean } = {}): InboundMessage {
  return {
    seq: 1,
    messageId: 1,
    fromUserId: options.from ?? '555',
    toUserId: '42',
    createdAt: 1,
    items: text === undefined
      ? [{ kind: 'voice' as const }]
      : options.voice === true
        ? [{ kind: 'voice' as const, text }]
        : [{ kind: 'text' as const, text }],
  }
}

function controller() {
  const actions = {
    sendPrompt: vi.fn(async () => {}),
    setPaused: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  }
  const instance = new RemoteController({ actions, now: () => 0, code: () => 'a3f9' })
  instance.track({ id: 's1', title: '周报导出', running: true }, 0)
  return { instance, actions }
}

function harness(options: {
  readonly pages: UpdatesPage[]
  readonly bindings?: BindingStore
  readonly capabilities?: ChannelCapabilities
}) {
  const controllerInstance = controller()
  const bindings = options.bindings ?? new BindingStore({ filePath: null, now: () => 0 })
  const sent: { chatId: string; text: string }[] = []
  const pages = [...options.pages]
  let adapter: TelegramAdapter
  const getUpdates = vi.fn(async (cursor?: string) => {
    if (pages.length === 0) {
      adapter.stop()
      return { cursor: cursor ?? '', messages: [] }
    }
    return pages.shift() ?? { cursor: '', messages: [] }
  })
  const sendText = vi.fn(async (_credentials: unknown, _chatId: string, text: string) => {
    sent.push({ chatId: _chatId, text })
    return 1
  })
  const transport = {
    getUpdates,
    sendText,
    validate: vi.fn(async () => ({ id: '42', username: 'dsh_bot' })),
  } as unknown as TelegramTransport
  adapter = new TelegramAdapter({
    transport,
    credentials: { token: '123456:ABC-def_ghi' },
    controller: controllerInstance.instance,
    bindings,
    capabilities: options.capabilities ?? textOnly,
    sleep: async () => {},
    emptyPageDelayMs: 1,
  })
  return { adapter, bindings, sent, getUpdates }
}

describe('TelegramAdapter', () => {
  it('runs a bound chat command', async () => {
    const bindings = new BindingStore({ filePath: null, now: () => 0 })
    bindings.bind('555', 'telegram')
    const { adapter, sent } = harness({ pages: [{ cursor: '2', messages: [message('任务')] }], bindings })
    await adapter.run()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.chatId).toBe('555')
    expect(sent[0]?.text).toContain('1 周报导出')
  })

  it('asks an unbound chat to pair first', async () => {
    const { adapter, sent } = harness({ pages: [{ cursor: '2', messages: [message('hi')] }] })
    await adapter.run()
    expect(sent[0]?.text).toContain('绑定')
  })

  it('accepts a Telegram code and rejects a WeChat code', async () => {
    const values = ['246810', '135790']
    let index = 0
    const bindings = new BindingStore({
      filePath: null,
      now: () => 0,
      code: () => values[Math.min(index++, values.length - 1)] ?? '999999',
    })
    const weixinCode = bindings.issueCode(1_000, 'weixin').code
    const telegramCode = bindings.issueCode(1_000, 'telegram').code
    const { adapter, sent } = harness({
      pages: [{
        cursor: '2',
        messages: [message(weixinCode), message(telegramCode)],
      }],
      bindings,
    })
    await adapter.run()
    expect(sent[0]?.text).toContain('不是 Telegram')
    expect(bindings.isBound('555')).toBe(true)
    expect(bindings.binding('555')?.channel).toBe('telegram')
    expect(sent[1]?.text).toContain('已绑定')
  })

  it('explains that voice and media need the desktop', async () => {
    const bindings = new BindingStore({ filePath: null, now: () => 0 })
    bindings.bind('555', 'telegram')
    const { adapter, sent } = harness({ pages: [{ cursor: '2', messages: [message(undefined)] }], bindings })
    await adapter.run()
    expect(sent[0]?.text).toContain('只支持文字')
  })
})
