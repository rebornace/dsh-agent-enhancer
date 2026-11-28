import type { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteHub } from '../src/host/remote/hub.ts'
import type { WeixinCredentialStore } from '../src/host/remote/weixin/credentials.ts'
import type { TelegramCredentialStore } from '../src/host/remote/telegram/credentials.ts'
import type { FeishuCredentialStore } from '../src/host/remote/feishu/credentials.ts'
import type { WeixinTransport } from '../src/host/remote/weixin/transport.ts'
import type { TelegramTransport } from '../src/host/remote/telegram/transport.ts'
import type { FeishuTransport } from '../src/host/remote/feishu/transport.ts'
import type { InboundMessage, UpdatesPage } from '../src/host/remote/channels/types.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function rootDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-'))
  dirs.push(dir)
  return dir
}

function memoryStore<T>(initial?: T): { value?: T; load(): Promise<T | undefined>; save(v: T): Promise<void>; clear(): Promise<void> } {
  const store = {
    value: initial,
    async load() {
      return store.value
    },
    async save(value: T) {
      store.value = value
    },
    async clear() {
      store.value = undefined
    },
  }
  return store
}

function message(from: string, text: string): InboundMessage {
  return {
    seq: 1,
    messageId: 1,
    fromUserId: from,
    toUserId: 'bot',
    createdAt: 1,
    items: [{ kind: 'text', text }],
  }
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timeout waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

interface HarnessOptions {
  readonly weixin?: { baseUrl: string; token: string; botId?: string }
  readonly telegram?: { token: string; botId?: string; username?: string }
  readonly feishu?: { appId: string; appSecret: string; name?: string }
}

function harness(options: HarnessOptions) {
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const sessionController = {
    list: vi.fn(async () => ({
      items: [{ sessionId: 's1', running: true, projections: { values: { title: '周报导出' } } }],
    })),
    prompt: vi.fn(async () => ({ accepted: true })),
    cancel: vi.fn(async () => ({ accepted: true })),
  }
  const ctx = {
    on: (name: string, listener: (...args: never[]) => unknown) => {
      handlers.set(name, listener)
      return () => handlers.delete(name)
    },
    get: (name: string) => (name === 'sessionController' ? sessionController : undefined),
  } as unknown as Context

  const sent: {
    channel: 'weixin' | 'telegram' | 'feishu'
    chatId: string
    text: string
    buttons?: readonly { label: string; command: string }[]
  }[] = []
  const weixinPages: UpdatesPage[] = []
  const telegramPages: UpdatesPage[] = []
  const feishuPages: UpdatesPage[] = []

  const weixinTransport = {
    beginLogin: vi.fn(async () => ({ ticket: 't1', qrUrl: 'https://liteapp.weixin.qq.com/q/x?type=3' })),
    pollLogin: vi.fn(async () => ({ status: 'wait' })),
    getUpdates: vi.fn(async (_credentials: unknown, cursor?: string) => (
      weixinPages.shift() ?? { cursor: cursor ?? '', messages: [] }
    )),
    sendText: vi.fn(async (
      _credentials: unknown,
      chatId: string,
      text: string,
      options?: { readonly buttons?: readonly { label: string; command: string }[] },
    ) => {
      sent.push({ channel: 'weixin', chatId, text, ...(options?.buttons === undefined ? {} : { buttons: options.buttons }) })
      return 1
    }),
  } as unknown as WeixinTransport

  const telegramTransport = {
    validate: vi.fn(async () => ({ id: '42', username: 'dsh_bot' })),
    getUpdates: vi.fn(async (_credentials: unknown, cursor?: string) => (
      telegramPages.shift() ?? { cursor: cursor ?? '', messages: [] }
    )),
    sendText: vi.fn(async (
      _credentials: unknown,
      chatId: string,
      text: string,
      options?: { readonly buttons?: readonly { label: string; command: string }[] },
    ) => {
      sent.push({ channel: 'telegram', chatId, text, ...(options?.buttons === undefined ? {} : { buttons: options.buttons }) })
      return 1
    }),
  } as unknown as TelegramTransport

  const feishuTransport = {
    validate: vi.fn(async () => ({ name: 'DSH 助手' })),
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    getUpdates: vi.fn(async (cursor?: string) => (
      feishuPages.shift() ?? { cursor: cursor ?? '', messages: [] }
    )),
    sendText: vi.fn(async (
      _credentials: unknown,
      chatId: string,
      text: string,
      options?: { readonly buttons?: readonly { label: string; command: string }[] },
    ) => {
      sent.push({ channel: 'feishu', chatId, text, ...(options?.buttons === undefined ? {} : { buttons: options.buttons }) })
      return 'om_1'
    }),
  } as unknown as FeishuTransport

  const weixinStore = memoryStore<{ baseUrl: string; token: string; botId?: string }>(
    options.weixin === undefined ? undefined : { ...options.weixin },
  )
  const telegramStore = memoryStore<{ token: string; botId?: string; username?: string }>(
    options.telegram === undefined ? undefined : { ...options.telegram },
  )
  const feishuStore = memoryStore<{ appId: string; appSecret: string; name?: string }>(
    options.feishu === undefined ? undefined : { ...options.feishu },
  )

  const hub = new RemoteHub({
    ctx,
    rootDir: rootDir(),
    setPaused: vi.fn(async () => {}),
    createWeixinTransport: () => weixinTransport,
    createTelegramTransport: () => telegramTransport,
    createFeishuTransport: () => feishuTransport,
    weixinCredentials: weixinStore as unknown as WeixinCredentialStore,
    telegramCredentials: telegramStore as unknown as TelegramCredentialStore,
    feishuCredentials: feishuStore as unknown as FeishuCredentialStore,
    emptyPageDelayMs: 1,
  })

  return {
    hub,
    sent,
    weixinTransport,
    telegramTransport,
    feishuTransport,
    weixinPages,
    telegramPages,
    feishuPages,
    weixinStore,
    telegramStore,
    feishuStore,
    handlers,
    sessionController,
  }
}

describe('RemoteHub', () => {
  it('starts with every channel unbound and the shared task board', async () => {
    const { hub } = harness({})
    const status = await hub.start()
    expect(status.phase).toBe('unbound')
    expect(status.tasks).toBe(1)
    expect(status.channels.map(channel => channel.id)).toEqual(['weixin', 'telegram', 'feishu'])
    expect(status.channels.every(channel => channel.phase === 'unbound')).toBe(true)
    hub.stop()
  })

  it('connects Feishu with app credentials and binds a chat', async () => {
    const { hub, feishuPages, feishuStore } = harness({})
    await hub.start()
    const result = await hub.connectFeishu('cli_abc', 'secret')
    expect(result).toEqual({ ok: true, name: 'DSH 助手' })
    expect(feishuStore.value?.appId).toBe('cli_abc')
    await until(() => hub.status().channels.some(channel => channel.id === 'feishu' && channel.phase === 'running'))

    const code = hub.issueBindCode('feishu')
    feishuPages.push({ cursor: '', messages: [message('oc_chat', code.code)] })
    await until(() => hub.devices('feishu').length === 1)
    expect(hub.devices('feishu')[0]?.chatId).toBe('oc_chat')
    const feishu = hub.status().channels.find(channel => channel.id === 'feishu')
    expect(feishu?.handle).toBe('DSH 助手')
    hub.stop()
  })

  it('runs a stored WeChat login and reports its handle', async () => {
    const { hub } = harness({
      weixin: { baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'token', botId: 'bot-1' },
    })
    const status = await hub.start()
    const weixin = status.channels.find(channel => channel.id === 'weixin')
    expect(status.phase).toBe('running')
    expect(weixin?.phase).toBe('running')
    expect(weixin?.handle).toBe('bot-1')
    hub.stop()
  })

  it('connects Telegram with a token and persists it', async () => {
    const { hub, telegramStore } = harness({})
    await hub.start()
    const result = await hub.connectTelegram('123456:ABC-def_ghi')
    expect(result).toEqual({ ok: true, username: 'dsh_bot' })
    expect(telegramStore.value?.token).toBe('123456:ABC-def_ghi')
    const telegram = hub.status().channels.find(channel => channel.id === 'telegram')
    expect(telegram?.phase).toBe('running')
    expect(telegram?.handle).toBe('@dsh_bot')
    hub.stop()
  })

  it('binds chats per channel with a one-shot code and revokes by channel', async () => {
    const { hub, sent, weixinPages, telegramPages } = harness({
      weixin: { baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'token' },
      telegram: { token: '123456:ABC-def_ghi' },
    })
    await hub.start()

    const wx = hub.issueBindCode('weixin')
    weixinPages.push({ cursor: 'c1', messages: [message('wx-chat', wx.code)] })
    await until(() => hub.devices('weixin').length === 1)
    expect(sent.some(entry => entry.channel === 'weixin' && entry.text.includes('已绑定'))).toBe(true)

    const tg = hub.issueBindCode('telegram')
    telegramPages.push({ cursor: 't1', messages: [message('tg-chat', tg.code)] })
    await until(() => hub.devices('telegram').length === 1)

    expect(hub.devices().map(device => device.chatId).sort()).toEqual(['tg-chat', 'wx-chat'])
    expect(hub.revoke('telegram', 'tg-chat')).toBe(1)
    expect(hub.devices('telegram')).toHaveLength(0)
    expect(hub.devices('weixin')).toHaveLength(1)
    hub.stop()
  })

  it('pushes a failure to every paired chat on its own channel', async () => {
    const { hub, sent, handlers, weixinPages, telegramPages, feishuPages } = harness({
      weixin: { baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'token' },
      telegram: { token: '123456:ABC-def_ghi' },
      feishu: { appId: 'cli_abc', appSecret: 'secret', name: 'DSH 助手' },
    })
    await hub.start()

    const wx = hub.issueBindCode('weixin')
    weixinPages.push({ cursor: 'c1', messages: [message('wx-chat', wx.code)] })
    await until(() => hub.devices('weixin').length === 1)
    const tg = hub.issueBindCode('telegram')
    telegramPages.push({ cursor: 't1', messages: [message('tg-chat', tg.code)] })
    await until(() => hub.devices('telegram').length === 1)
    const fs = hub.issueBindCode('feishu')
    feishuPages.push({ cursor: '', messages: [message('oc-chat', fs.code)] })
    await until(() => hub.devices('feishu').length === 1)

    sent.length = 0
    const onEvent = handlers.get('session/event')
    if (onEvent === undefined) throw new Error('missing session/event handler')
    onEvent({ id: 's1' } as never, {
      type: 'turn/end',
      time: 10_000,
      data: { reason: { kind: 'error', error: { message: '模型超时' } } },
    } as never)

    await until(() => sent.length >= 3)
    expect(sent.some(entry => entry.channel === 'weixin' && entry.text.includes('模型超时'))).toBe(true)
    expect(sent.some(entry => entry.channel === 'telegram' && entry.text.includes('模型超时'))).toBe(true)
    expect(sent.some(entry => entry.channel === 'feishu' && entry.text.includes('模型超时'))).toBe(true)
    const telegram = sent.find(entry => entry.channel === 'telegram' && entry.text.includes('模型超时'))
    expect(telegram?.buttons).toEqual([{ label: '详情', command: '详情 1' }])
    const feishu = sent.find(entry => entry.channel === 'feishu' && entry.text.includes('模型超时'))
    expect(feishu?.buttons).toEqual([{ label: '详情', command: '详情 1' }])
    hub.stop()
  })

  it('adds decision buttons on Telegram but not WeChat', async () => {
    const { hub, sent, handlers, weixinPages, telegramPages } = harness({
      weixin: { baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'token' },
      telegram: { token: '123456:ABC-def_ghi' },
    })
    await hub.start()
    const wx = hub.issueBindCode('weixin')
    weixinPages.push({ cursor: 'c1', messages: [message('wx-chat', wx.code)] })
    await until(() => hub.devices('weixin').length === 1)
    const tg = hub.issueBindCode('telegram')
    telegramPages.push({ cursor: 't1', messages: [message('tg-chat', tg.code)] })
    await until(() => hub.devices('telegram').length === 1)

    sent.length = 0
    const onApproval = handlers.get('approval/request')
    if (onApproval === undefined) throw new Error('missing approval/request handler')
    onApproval({
      agent: { session: { id: 's1' } },
      toolName: 'write',
      reason: '写入 report.xlsx',
    } as never, (() => 'desktop') as never)

    await until(() => sent.filter(entry => entry.text.includes('请求执行')).length === 2)
    const telegram = sent.find(entry => entry.channel === 'telegram' && entry.text.includes('请求执行'))
    const weixin = sent.find(entry => entry.channel === 'weixin' && entry.text.includes('请求执行'))
    expect(telegram?.buttons?.map(button => button.label)).toEqual(['批准', '拒绝', '详情'])
    expect(telegram?.buttons?.find(button => button.label === '详情')?.command).toBe('详情 1')
    expect(weixin?.buttons).toBeUndefined()
    hub.stop()
  })

  it('tells paired chats when the desktop decides an approval', async () => {
    const { hub, sent, handlers, weixinPages, telegramPages, feishuPages } = harness({
      weixin: { baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'token' },
      telegram: { token: '123456:ABC-def_ghi' },
      feishu: { appId: 'cli_abc', appSecret: 'secret', name: 'DSH 助手' },
    })
    await hub.start()
    for (const [id, chatId] of [['weixin', 'wx-chat'], ['telegram', 'tg-chat'], ['feishu', 'oc-chat']] as const) {
      const code = hub.issueBindCode(id)
      const page = id === 'weixin' ? weixinPages : id === 'telegram' ? telegramPages : feishuPages
      page.push({ cursor: '', messages: [message(chatId, code.code)] })
      await until(() => hub.devices(id).length === 1)
    }

    sent.length = 0
    const onApproval = handlers.get('approval/request')
    if (onApproval === undefined) throw new Error('missing approval/request handler')
    let fromDesktop: (outcome: string) => void = () => {}
    const desktop = new Promise<string>(resolve => { fromDesktop = resolve })
    onApproval({
      agent: { session: { id: 's1' } },
      toolName: 'write',
      reason: '写入 report.xlsx',
    } as never, (() => desktop) as never)
    fromDesktop('allowed-once')

    await until(() => sent.filter(entry => entry.text.includes('已由桌面批准')).length >= 3)
    for (const channel of ['weixin', 'telegram', 'feishu']) {
      expect(sent.some(entry => entry.channel === channel && entry.text.includes('已由桌面批准'))).toBe(true)
    }
    hub.stop()
  })

  it('surfaces a WeChat push failure instead of claiming the channel is fine', async () => {
    const { hub, handlers, weixinPages, weixinTransport } = harness({
      weixin: { baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'token' },
    })
    await hub.start()
    const code = hub.issueBindCode('weixin')
    weixinPages.push({ cursor: 'c1', messages: [message('wx-chat', code.code)] })
    await until(() => hub.devices('weixin').length === 1)

    vi.mocked(weixinTransport.sendText).mockRejectedValueOnce({
      message: '微信服务拒绝了这条消息',
      detail: { providerCode: '-2' },
    })
    const onEvent = handlers.get('session/event')
    if (onEvent === undefined) throw new Error('missing session/event handler')
    onEvent({ id: 's1' } as never, {
      type: 'turn/end',
      time: 10_000,
      data: { reason: { kind: 'completed' } },
    } as never)

    await until(() => hub.status().channels.some(channel =>
      channel.id === 'weixin' && channel.error?.includes('微信会话已过期')))
    hub.stop()
  })

  it('forgets a deleted session and clears its focus', async () => {
    const { hub, weixinPages } = harness({
      weixin: { baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'token' },
    })
    await hub.start()
    const code = hub.issueBindCode('weixin')
    weixinPages.push({ cursor: 'c1', messages: [message('wx-chat', code.code)] })
    await until(() => hub.devices('weixin').length === 1)

    hub.forgetSession('s1')
    expect(hub.status().tasks).toBe(0)
    hub.stop()
  })
})
