import { describe, expect, it, vi } from 'vitest'
import { ChannelAuthError } from '../src/host/remote/channels/types.ts'
import {
  FeishuTransport,
  parseCardAction,
  parseMessageEvent,
} from '../src/host/remote/feishu/transport.ts'
import type { FeishuSdk } from '../src/host/remote/feishu/transport.ts'

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function messageEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '任务' }),
      create_time: '1700000000000',
      ...overrides,
    },
  }
}

interface FakeSdk {
  readonly sdk: FeishuSdk
  readonly handlers: Record<string, (data: unknown) => unknown>
  readonly starts: unknown[]
  readonly closes: unknown[]
}

function fakeSdk(): FakeSdk {
  const handlers: Record<string, (data: unknown) => unknown> = {}
  const starts: unknown[] = []
  const closes: unknown[] = []
  class Dispatcher {
    register(next: Record<string, (data: unknown) => unknown>): this {
      Object.assign(handlers, next)
      return this
    }
  }
  class Socket {
    async start(params: unknown): Promise<void> {
      starts.push(params)
    }
    close(params?: unknown): void {
      closes.push(params)
    }
  }
  const sdk = {
    WSClient: Socket,
    EventDispatcher: Dispatcher,
    LoggerLevel: { error: 1 },
  } as unknown as FeishuSdk
  return { sdk, handlers, starts, closes }
}

describe('FeishuTransport', () => {
  it('validates credentials and reads the bot name', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      if (String(url).endsWith('/auth/v3/tenant_access_token/internal')) {
        expect(JSON.parse(String(init?.body))).toEqual({ app_id: 'cli_abc', app_secret: 'secret' })
        return reply({ code: 0, tenant_access_token: 't-1', expire: 7200 })
      }
      if (String(url).endsWith('/bot/v3/info')) {
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer t-1')
        return reply({ code: 0, bot: { app_name: 'DSH 助手' } })
      }
      throw new Error(`unexpected url ${String(url)}`)
    }) as unknown as typeof fetch

    const transport = new FeishuTransport({ fetchImpl })
    await expect(transport.validate({ appId: 'cli_abc', appSecret: 'secret' })).resolves.toEqual({
      name: 'DSH 助手',
    })
    expect(calls).toHaveLength(2)
  })

  it('sends plain text and puts buttons on an interactive card', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/auth/v3/tenant_access_token/internal')) {
        return reply({ code: 0, tenant_access_token: 't-1', expire: 7200 })
      }
      expect(String(url)).toContain('/open-apis/im/v1/messages?receive_id_type=chat_id')
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return reply({ code: 0, data: { message_id: 'om_sent' } })
    }) as unknown as typeof fetch

    const transport = new FeishuTransport({ fetchImpl })
    const credentials = { appId: 'cli_abc', appSecret: 'secret' }
    await expect(transport.sendText(credentials, 'oc_1', '已绑定')).resolves.toBe('om_sent')
    expect(bodies[0]).toMatchObject({ receive_id: 'oc_1', msg_type: 'text' })
    expect(JSON.parse(String(bodies[0]?.content))).toEqual({ text: '已绑定' })

    await transport.sendText(credentials, 'oc_1', '请求执行', {
      buttons: [
        { label: '批准', command: '批准 a3f9' },
        { label: '详情', command: '详情 1' },
      ],
    })
    expect(bodies[1]?.msg_type).toBe('interactive')
    const card = JSON.parse(String(bodies[1]?.content)) as {
      elements: { tag: string; actions?: { value: { command: string } }[] }[]
    }
    const actions = card.elements.find(element => element.tag === 'action')
    expect(actions?.actions?.map(action => action.value.command)).toEqual(['批准 a3f9', '详情 1'])
  })

  it('maps an invalid app secret to an auth error with a next step', async () => {
    const fetchImpl = vi.fn(async () => reply({ code: 10014, msg: 'app secret invalid' })) as unknown as typeof fetch
    const transport = new FeishuTransport({ fetchImpl })
    await expect(transport.validate({ appId: 'cli_abc', appSecret: 'bad' })).rejects.toBeInstanceOf(
      ChannelAuthError,
    )
  })

  it('queues a pushed DM once and drains it for the poller', async () => {
    const { sdk, handlers, starts } = fakeSdk()
    const transport = new FeishuTransport({ waitTimeoutMs: 5, loadSdk: async () => sdk })
    await transport.start({ appId: 'cli_abc', appSecret: 'secret' })
    expect(starts).toHaveLength(1)

    handlers['im.message.receive_v1']?.(messageEvent())
    // A redelivery of the same message id must not double-handle it.
    handlers['im.message.receive_v1']?.(messageEvent())

    const page = await transport.getUpdates()
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]).toMatchObject({ fromUserId: 'oc_1' })
    expect(page.messages[0]?.items).toEqual([{ kind: 'text', text: '任务' }])

    const empty = await transport.getUpdates()
    expect(empty.messages).toHaveLength(0)
    transport.stop()
  })

  it('turns a card tap into its command and never dedupes two taps', async () => {
    const { sdk, handlers, closes } = fakeSdk()
    const transport = new FeishuTransport({ waitTimeoutMs: 5, loadSdk: async () => sdk })
    await transport.start({ appId: 'cli_abc', appSecret: 'secret' })

    const tap = {
      context: { open_chat_id: 'oc_1' },
      operator: { open_id: 'ou_1' },
      action: { value: { command: '详情 1' }, tag: 'button' },
    }
    expect(handlers['card.action.trigger']?.(tap)).toEqual({ toast: { type: 'info', content: '已收到' } })
    handlers['card.action.trigger']?.(tap)

    const page = await transport.getUpdates()
    expect(page.messages.map(message => message.items)).toEqual([
      [{ kind: 'text', text: '详情 1' }],
      [{ kind: 'text', text: '详情 1' }],
    ])

    transport.stop()
    expect(closes).toHaveLength(1)
  })
})

describe('Feishu event parsing', () => {
  it('reads direct text messages and ignores group or bot traffic', () => {
    expect(parseMessageEvent(messageEvent())?.items).toEqual([{ kind: 'text', text: '任务' }])
    expect(parseMessageEvent(messageEvent({ chat_type: 'group' }))).toBeUndefined()
    expect(parseMessageEvent({
      sender: { sender_type: 'app' },
      message: { chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: '{"text":"x"}' },
    })).toBeUndefined()
  })

  it('flattens rich text, and reports media honestly', () => {
    const post = parseMessageEvent(messageEvent({
      message_type: 'post',
      content: JSON.stringify({
        title: '周报',
        content: [[{ tag: 'text', text: '第一段' }], [{ tag: 'text', text: '第二段' }]],
      }),
    }))
    expect(post?.items).toEqual([{ kind: 'text', text: '周报\n第一段\n第二段' }])

    expect(parseMessageEvent(messageEvent({ message_type: 'image', content: '{"image_key":"k"}' }))?.items)
      .toEqual([{ kind: 'image' }])
    expect(parseMessageEvent(messageEvent({ message_type: 'audio', content: '{}' }))?.items)
      .toEqual([{ kind: 'voice' }])
    expect(parseMessageEvent(messageEvent({ message_type: 'file', content: '{}' }))?.items)
      .toEqual([{ kind: 'file' }])
  })

  it('ignores a card tap without a chat or a command', () => {
    expect(parseCardAction({ context: { open_chat_id: 'oc_1' }, action: { value: {} } })).toBeUndefined()
    expect(parseCardAction({ action: { value: { command: '任务' } } })).toBeUndefined()
  })
})
