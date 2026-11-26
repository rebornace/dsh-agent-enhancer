import type { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteHub } from '../src/host/remote/hub.ts'
import type { WeixinCredentialStore } from '../src/host/remote/weixin/credentials.ts'
import type { TelegramCredentialStore } from '../src/host/remote/telegram/credentials.ts'
import type { WeixinTransport } from '../src/host/remote/weixin/transport.ts'
import type { TelegramTransport } from '../src/host/remote/telegram/transport.ts'
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

  const sent: { channel: 'weixin' | 'telegram'; chatId: string; text: string }[] = []
  const weixinPages: UpdatesPage[] = []
  const telegramPages: UpdatesPage[] = []

  const weixinTransport = {
    beginLogin: vi.fn(async () => ({ ticket: 't1', qrUrl: 'https://liteapp.weixin.qq.com/q/x?type=3' })),
    pollLogin: vi.fn(async () => ({ status: 'wait' })),
    getUpdates: vi.fn(async (_credentials: unknown, cursor?: string) => (
      weixinPages.shift() ?? { cursor: cursor ?? '', messages: [] }
    )),
    sendText: vi.fn(async (_credentials: unknown, chatId: string, text: string) => {
      sent.push({ channel: 'weixin', chatId, text })
      return 1
    }),
  } as unknown as WeixinTransport

  const telegramTransport = {
    validate: vi.fn(async () => ({ id: '42', username: 'dsh_bot' })),
    getUpdates: vi.fn(async (_credentials: unknown, cursor?: string) => (
      telegramPages.shift() ?? { cursor: cursor ?? '', messages: [] }
    )),
    sendText: vi.fn(async (_credentials: unknown, chatId: string, text: string) => {
      sent.push({ channel: 'telegram', chatId, text })
      return 1
    }),
  } as unknown as TelegramTransport

  const weixinStore = memoryStore<{ baseUrl: string; token: string; botId?: string }>(
    options.weixin === undefined ? undefined : { ...options.weixin },
  )
  const telegramStore = memoryStore<{ token: string; botId?: string; username?: string }>(
    options.telegram === undefined ? undefined : { ...options.telegram },
  )

  const hub = new RemoteHub({
    ctx,
    rootDir: rootDir(),
    setPaused: vi.fn(async () => {}),
    createWeixinTransport: () => weixinTransport,
    createTelegramTransport: () => telegramTransport,
    weixinCredentials: weixinStore as unknown as WeixinCredentialStore,
    telegramCredentials: telegramStore as unknown as TelegramCredentialStore,
    emptyPageDelayMs: 1,
  })

  return { hub, sent, weixinPages, telegramPages, weixinStore, telegramStore, handlers, sessionController }
}

describe('RemoteHub', () => {
  it('starts with both channels unbound and the shared task board', async () => {
    const { hub } = harness({})
    const status = await hub.start()
    expect(status.phase).toBe('unbound')
    expect(status.tasks).toBe(1)
    expect(status.channels.map(channel => channel.id)).toEqual(['weixin', 'telegram'])
    expect(status.channels.every(channel => channel.phase === 'unbound')).toBe(true)
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
    const onEvent = handlers.get('session/event')
    if (onEvent === undefined) throw new Error('missing session/event handler')
    onEvent({ id: 's1' } as never, {
      type: 'turn/end',
      time: 10_000,
      data: { reason: { kind: 'error', error: { message: '模型超时' } } },
    } as never)

    await until(() => sent.length >= 2)
    expect(sent.some(entry => entry.channel === 'weixin' && entry.text.includes('模型超时'))).toBe(true)
    expect(sent.some(entry => entry.channel === 'telegram' && entry.text.includes('模型超时'))).toBe(true)
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
