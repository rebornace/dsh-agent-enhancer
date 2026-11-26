import { describe, expect, it, vi } from 'vitest'
import { BindingStore } from '../src/host/remote/bindings.ts'
import { RemoteController } from '../src/host/remote/controller.ts'
import { WeixinAdapter } from '../src/host/remote/weixin/adapter.ts'
import { WeixinTransportError } from '../src/host/remote/weixin/transport.ts'
import type { InboundMessage, UpdatesPage } from '../src/host/remote/weixin/transport.ts'
import type { ChannelCapabilities } from '../src/host/remote/types.ts'

const textOnly: ChannelCapabilities = {
  buttons: false,
  editMessage: false,
  threads: false,
  media: 'none',
  markdown: false,
  maxChars: 1800,
  privateOnly: true,
}

function message(text: string | undefined, options: { from?: string; voice?: boolean; image?: boolean } = {}): InboundMessage {
  const items = text === undefined
    ? (options.image === true ? [{ kind: 'image' as const }] : [])
    : options.voice === true
      ? [{ kind: 'voice' as const, text }]
      : [{ kind: 'text' as const, text }]
  return {
    seq: 1,
    messageId: 1,
    fromUserId: options.from ?? 'chat-1',
    toUserId: 'bot-1',
    createdAt: 1,
    items,
    contextToken: 'ctx-1',
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
  readonly failOnce?: { error: unknown }
  readonly onFatal?: (error: unknown) => void
  readonly sleep?: (ms: number) => Promise<void>
  readonly refresh?: () => Promise<unknown>
}) {
  const controllerInstance = controller()
  const bindings = options.bindings ?? new BindingStore({ filePath: null, now: () => 0 })
  const sent: { chatId: string; text: string; contextToken?: string }[] = []
  const pages = [...options.pages]
  let failError = options.failOnce?.error
  let adapter: WeixinAdapter
  const getUpdates = vi.fn(async () => {
    if (failError !== undefined) {
      const error = failError
      failError = undefined
      throw error
    }
    if (pages.length === 0) {
      adapter.stop()
      return { cursor: '', messages: [] }
    }
    const page = pages.shift()
    return page ?? { cursor: '', messages: [] }
  })
  const sendText = vi.fn(async (
    _credentials: unknown,
    chatId: string,
    text: string,
    sendOptions?: { readonly contextToken?: string },
  ) => {
    sent.push({ chatId, text, ...(sendOptions?.contextToken === undefined ? {} : { contextToken: sendOptions.contextToken }) })
    return 1
  })
  adapter = new WeixinAdapter({
    transport: { getUpdates, sendText },
    controller: controllerInstance.instance,
    bindings,
    credentials: { baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'token' },
    capabilities: options.capabilities ?? textOnly,
    sleep: options.sleep ?? (async () => {}),
    ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
    ...(options.onFatal === undefined ? {} : { onFatal: options.onFatal }),
  })
  return { adapter, bindings, sent, getUpdates, actions: controllerInstance.actions }
}

describe('WeixinAdapter', () => {
  it('executes a bound chat message and replies once', async () => {
    const bindings = new BindingStore({ filePath: null, now: () => 0 })
    bindings.bind('chat-1', 'weixin')
    const { adapter, sent } = harness({ pages: [{ cursor: 'c1', messages: [message('任务')] }], bindings })

    await adapter.run()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.chatId).toBe('chat-1')
    expect(sent[0]?.text).toContain('1 周报导出')
    expect(sent[0]?.contextToken).toBe('ctx-1')
  })

  it('refreshes the session list before running a command', async () => {
    const bindings = new BindingStore({ filePath: null, now: () => 0 })
    bindings.bind('chat-1', 'weixin')
    const refresh = vi.fn(async () => {})
    const { adapter } = harness({
      pages: [{ cursor: 'c1', messages: [message('任务')] }],
      bindings,
      refresh,
    })
    await adapter.run()
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('remembers the chosen task for the next message', async () => {
    const bindings = new BindingStore({ filePath: null, now: () => 0 })
    bindings.bind('chat-1', 'weixin')
    const { adapter } = harness({
      pages: [{ cursor: 'c1', messages: [message('切 1'), message('再改一下')] }],
      bindings,
    })
    await adapter.run()
    expect(bindings.binding('chat-1')?.focusSessionId).toBe('s1')
  })

  it('asks an unbound chat to redeem a code first', async () => {
    const { adapter, sent } = harness({ pages: [{ cursor: 'c1', messages: [message('你好')] }] })
    await adapter.run()
    expect(sent[0]?.text).toContain('绑定')
  })

  it('binds a chat with a code and rejects it afterwards', async () => {
    const bindings = new BindingStore({ filePath: null, now: () => 0, code: () => '246810' })
    const { code } = bindings.issueCode()
    const { adapter, sent } = harness({
      pages: [{
        cursor: 'c1',
        messages: [message(code, { from: 'chat-1' }), message(code, { from: 'chat-2' })],
      }],
      bindings,
    })

    await adapter.run()
    expect(bindings.isBound('chat-1')).toBe(true)
    expect(sent[0]?.text).toContain('已绑定')
    // The second chat tries the same one-shot code after it was consumed.
    expect(sent[1]?.text).toContain('无效或已过期')
    expect(bindings.isBound('chat-2')).toBe(false)
  })

  it('rejects an expired code', async () => {
    const clock = { now: 0 }
    const bindings = new BindingStore({ filePath: null, now: () => clock.now, code: () => '246810' })
    bindings.issueCode(1)
    clock.now = 10
    const { adapter, sent } = harness({ pages: [{ cursor: 'c1', messages: [message('246810')] }], bindings })
    await adapter.run()
    expect(bindings.isBound('chat-1')).toBe(false)
    expect(sent[0]?.text).toContain('无效或已过期')
  })

  it('accepts the protocol voice transcription as user text', async () => {
    const bindings = new BindingStore({ filePath: null, now: () => 0 })
    bindings.bind('chat-1', 'weixin')
    const { adapter, sent } = harness({
      pages: [{ cursor: 'c1', messages: [message('任务', { voice: true })] }],
      bindings,
    })
    await adapter.run()
    expect(sent[0]?.text).toContain('1 周报导出')
  })

  it('explains unsupported media instead of dropping it', async () => {
    const bindings = new BindingStore({ filePath: null, now: () => 0 })
    bindings.bind('chat-1', 'weixin')
    const { adapter, sent } = harness({ pages: [{ cursor: 'c1', messages: [message(undefined, { image: true })] }], bindings })
    await adapter.run()
    expect(sent[0]?.text).toContain('只支持文字和语音')
  })

  it('chunks a long reply to the channel budget', async () => {
    const bindings = new BindingStore({ filePath: null, now: () => 0 })
    bindings.bind('chat-1', 'weixin')
    const controllerInstance = new RemoteController({ actions: { sendPrompt: vi.fn(), setPaused: vi.fn(), stop: vi.fn() } })
    controllerInstance.track({ id: 's1', title: '很长的任务标题'.repeat(20), running: true }, 0)
    const pages = [{ cursor: 'c1', messages: [message('任务')] }]
    let adapter: WeixinAdapter
    const sent: string[] = []
    const getUpdates = vi.fn(async () => {
      if (pages.length === 0) {
        adapter.stop()
        return { cursor: '', messages: [] }
      }
      return pages.shift() ?? { cursor: '', messages: [] }
    })
    const sendText = vi.fn(async (_c: unknown, _chat: string, text: string) => {
      sent.push(text)
      return 1
    })
    adapter = new WeixinAdapter({
      transport: { getUpdates, sendText },
      controller: controllerInstance,
      bindings,
      credentials: { baseUrl: 'https://ilinkai.weixin.qq.com/', token: 't' },
      capabilities: { ...textOnly, maxChars: 40 },
      sleep: async () => {},
    })
    await adapter.run()
    expect(sent.length).toBeGreaterThan(1)
    for (const chunk of sent) expect(chunk.length).toBeLessThanOrEqual(40)
  })

  it('stops on a stale token and reports it', async () => {
    const fatal = vi.fn()
    const { adapter, getUpdates } = harness({
      pages: [],
      failOnce: { error: new WeixinTransportError('stale-token', 'stale') },
      onFatal: fatal,
    })
    await adapter.run()
    expect(fatal).toHaveBeenCalledOnce()
    expect(getUpdates).toHaveBeenCalledTimes(1)
    expect(adapter.running).toBe(false)
  })

  it('backs off on a transient error and continues', async () => {
    const sleep = vi.fn(async () => {})
    const { adapter, sent } = harness({
      pages: [{ cursor: 'c1', messages: [message('任务')] }],
      bindings: (() => {
        const store = new BindingStore({ filePath: null, now: () => 0 })
        store.bind('chat-1', 'weixin')
        return store
      })(),
      failOnce: { error: new Error('network') },
      sleep,
    })
    await adapter.run()
    expect(sleep).toHaveBeenCalledWith(250)
    expect(sent[0]?.text).toContain('1 周报导出')
  })
})
