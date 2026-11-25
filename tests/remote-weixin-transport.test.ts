import { describe, expect, it } from 'vitest'
import { WeixinTransport } from '../src/host/remote/weixin/transport.ts'
import type { WeixinCredentials } from '../src/host/remote/weixin/transport.ts'

interface Route {
  readonly match: (url: URL) => boolean
  readonly body: unknown
  readonly status?: number
}

function fakeFetch(routes: readonly Route[]) {
  const calls: { url: URL; body: unknown }[] = []
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const route = routes.find(candidate => candidate.match(url))
    calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    if (route === undefined) throw new Error(`no route for ${url.pathname}`)
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 })
  }
  return { impl: impl as typeof fetch, calls }
}

const credentials: WeixinCredentials = { baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'tok' }

describe('WeixinTransport login', () => {
  it('requests a QR with the bot type and returns the payload URL', async () => {
    const { impl, calls } = fakeFetch([{
      match: url => url.pathname.includes('get_bot_qrcode'),
      body: { ret: 0, qrcode: 'ticket-1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/abc' },
    }])
    const transport = new WeixinTransport({ fetchImpl: impl })
    const ticket = await transport.beginLogin(['old-token'])

    expect(ticket).toEqual({ ticket: 'ticket-1', qrUrl: 'https://liteapp.weixin.qq.com/q/abc' })
    expect(calls[0]?.url.searchParams.get('bot_type')).toBe('3')
    expect(calls[0]?.body).toEqual({ local_token_list: ['old-token'] })
  })

  it('rejects a QR URL outside WeChat hosts', async () => {
    const { impl } = fakeFetch([{
      match: url => url.pathname.includes('get_bot_qrcode'),
      body: { ret: 0, qrcode: 'ticket-1', qrcode_img_content: 'https://evil.example/q' },
    }])
    const transport = new WeixinTransport({ fetchImpl: impl })
    await expect(transport.beginLogin()).rejects.toMatchObject({ code: 'untrusted-qr' })
  })

  it('returns credentials only on confirmation', async () => {
    const waiting = fakeFetch([{
      match: url => url.pathname.includes('get_qrcode_status'),
      body: { ret: 0, status: 'wait' },
    }])
    await expect(new WeixinTransport({ fetchImpl: waiting.impl }).pollLogin('t')).resolves.toEqual({ status: 'wait' })

    const confirmed = fakeFetch([{
      match: url => url.pathname.includes('get_qrcode_status'),
      body: {
        ret: 0,
        status: 'confirmed',
        baseurl: 'https://ilinkai.weixin.qq.com',
        bot_token: 'bot-token',
        ilink_bot_id: 'bot-1',
        ilink_user_id: 'user-1',
      },
    }])
    const poll = await new WeixinTransport({ fetchImpl: confirmed.impl }).pollLogin('t')
    expect(poll.status).toBe('confirmed')
    expect(poll.credentials).toEqual({
      baseUrl: 'https://ilinkai.weixin.qq.com/',
      token: 'bot-token',
      botId: 'bot-1',
      userId: 'user-1',
    })
  })
})

describe('WeixinTransport updates', () => {
  it('parses text, voice transcription, image and file items', async () => {
    const { impl, calls } = fakeFetch([{
      match: url => url.pathname.includes('getupdates'),
      body: {
        msgs: [
          {
            seq: 1,
            message_id: 101,
            from_user_id: 'user-1',
            to_user_id: 'bot-1',
            create_time_ms: 10,
            item_list: [{ type: 1, text_item: { text: '测试' } }],
            context_token: 'ctx-1',
          },
          {
            seq: 2,
            message_id: 102,
            from_user_id: 'user-1',
            to_user_id: 'bot-1',
            create_time_ms: 20,
            item_list: [{ type: 3, voice_item: { text: '语音转写' } }],
          },
          {
            seq: 3,
            message_id: 103,
            from_user_id: 'user-1',
            to_user_id: 'bot-1',
            create_time_ms: 30,
            item_list: [{ type: 2 }, { type: 4 }],
          },
        ],
        get_updates_buf: 'cursor-2',
      },
    }])
    const transport = new WeixinTransport({ fetchImpl: impl })
    const page = await transport.getUpdates(credentials, 'cursor-1')

    expect(page.cursor).toBe('cursor-2')
    expect(page.messages).toHaveLength(3)
    expect(page.messages[0]?.items).toEqual([{ kind: 'text', text: '测试' }])
    expect(page.messages[0]?.contextToken).toBe('ctx-1')
    expect(page.messages[1]?.items).toEqual([{ kind: 'voice', text: '语音转写' }])
    expect(page.messages[2]?.items).toEqual([{ kind: 'image' }, { kind: 'file' }])
    expect(calls[0]?.body).toMatchObject({ get_updates_buf: 'cursor-1' })
  })

  it('treats a client-side timeout as an empty page with the same cursor', async () => {
    const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })) as typeof fetch
    const transport = new WeixinTransport({ fetchImpl: impl, pollTimeoutMs: 5 })
    await expect(transport.getUpdates(credentials, 'cursor-9')).resolves.toEqual({
      cursor: 'cursor-9',
      messages: [],
    })
  })

  it('surfaces a stale token instead of looping', async () => {
    const { impl } = fakeFetch([{
      match: url => url.pathname.includes('getupdates'),
      body: { ret: -14 },
    }])
    const transport = new WeixinTransport({ fetchImpl: impl })
    await expect(transport.getUpdates(credentials)).rejects.toMatchObject({ code: 'stale-token' })
  })
})

describe('WeixinTransport sendText', () => {
  it('builds the outbound message with a stable client id prefix', async () => {
    const { impl, calls } = fakeFetch([{
      match: url => url.pathname.includes('sendmessage'),
      body: { message_id: 9001 },
    }])
    const transport = new WeixinTransport({ fetchImpl: impl })
    const id = await transport.sendText(credentials, 'user-1', '你好', { contextToken: 'ctx-1' })

    expect(id).toBe(9001)
    const body = calls[0]?.body as {
      msg?: {
        to_user_id?: string
        client_id?: string
        message_type?: number
        message_state?: number
        item_list?: unknown
        context_token?: string
      }
    } | undefined
    expect(body?.msg?.to_user_id).toBe('user-1')
    expect(body?.msg?.client_id).toMatch(/^dsh-enhancer-/)
    expect(body?.msg?.message_type).toBe(2)
    expect(body?.msg?.message_state).toBe(2)
    expect(body?.msg?.item_list).toEqual([{ type: 1, text_item: { text: '你好' } }])
    expect(body?.msg?.context_token).toBe('ctx-1')
  })

  it('rejects provider errors', async () => {
    const { impl } = fakeFetch([{
      match: url => url.pathname.includes('sendmessage'),
      body: { ret: -14 },
    }])
    const transport = new WeixinTransport({ fetchImpl: impl })
    await expect(transport.sendText(credentials, 'user-1', 'hi')).rejects.toMatchObject({ code: 'send-rejected' })
  })

  it('refuses an untrusted credential base URL', async () => {
    const { impl } = fakeFetch([])
    const transport = new WeixinTransport({ fetchImpl: impl })
    await expect(transport.sendText({ baseUrl: 'https://evil.example/', token: 't' }, 'u', 'hi'))
      .rejects.toMatchObject({ code: 'untrusted-base-url' })
  })
})
