import { describe, expect, it, vi } from 'vitest'
import { ChannelAuthError } from '../src/host/remote/channels/types.ts'
import { TelegramTransport, TelegramTransportError } from '../src/host/remote/telegram/transport.ts'

interface Reply {
  readonly status?: number
  readonly body: unknown
}

function fetchQueue(replies: Reply[]) {
  const calls: { url: string; body: unknown }[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const reply = replies.shift() ?? { body: { ok: true, result: true } }
    calls.push({
      url: String(url),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
    })
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

const credentials = { token: '123456:ABC-def_ghi' }

describe('TelegramTransport', () => {
  it('validates a bot token with getMe', async () => {
    const { fetchImpl, calls } = fetchQueue([{ body: { ok: true, result: { id: 42, username: 'dsh_bot' } } }])
    const transport = new TelegramTransport({ fetchImpl })
    await expect(transport.validate(credentials)).resolves.toEqual({ id: '42', username: 'dsh_bot' })
    expect(calls[0]?.url).toContain('/bot123456:ABC-def_ghi/getMe')
  })

  it('maps a private text update and advances the cursor', async () => {
    const { fetchImpl } = fetchQueue([{
      body: {
        ok: true,
        result: [{
          update_id: 10,
          message: {
            message_id: 7,
            date: 1_700_000_000,
            chat: { id: 555, type: 'private' },
            from: { id: 555 },
            text: '任务',
          },
        }],
      },
    }])
    const transport = new TelegramTransport({ fetchImpl })
    const page = await transport.getUpdates(credentials, '')
    expect(page.cursor).toBe('11')
    expect(page.messages).toEqual([{
      seq: 7,
      messageId: 7,
      fromUserId: '555',
      toUserId: '555',
      createdAt: 1_700_000_000_000,
      items: [{ kind: 'text', text: '任务' }],
    }])
  })

  it('ignores group chats and maps media to neutral items', async () => {
    const { fetchImpl, calls } = fetchQueue([{
      body: {
        ok: true,
        result: [
          { update_id: 20, message: { message_id: 1, date: 1, chat: { id: -9, type: 'group' }, text: 'hi' } },
          { update_id: 21, message: { message_id: 2, date: 1, chat: { id: 555, type: 'private' }, photo: [{}] } },
        ],
      },
    }])
    const transport = new TelegramTransport({ fetchImpl })
    const page = await transport.getUpdates(credentials, '')
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]?.items).toEqual([{ kind: 'image' }])
    expect(calls[0]?.body).toMatchObject({ timeout: 25, allowed_updates: ['message', 'callback_query'] })
  })

  it('sends the cursor as the update offset', async () => {
    const { fetchImpl, calls } = fetchQueue([{ body: { ok: true, result: [] } }])
    const transport = new TelegramTransport({ fetchImpl })
    await expect(transport.getUpdates(credentials, '42')).resolves.toEqual({ cursor: '42', messages: [] })
    expect(calls[0]?.body).toMatchObject({ offset: 42 })
  })

  it('sends text and returns the message id', async () => {
    const { fetchImpl, calls } = fetchQueue([{ body: { ok: true, result: { message_id: 99 } } }])
    const transport = new TelegramTransport({ fetchImpl })
    await expect(transport.sendText(credentials, '555', '你好')).resolves.toBe(99)
    expect(calls[0]?.url).toContain('/sendMessage')
    expect(calls[0]?.body).toMatchObject({ chat_id: '555', text: '你好', disable_web_page_preview: true })
  })

  it('turns a revoked token into a fatal auth error', async () => {
    const { fetchImpl } = fetchQueue([{ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }])
    const transport = new TelegramTransport({ fetchImpl })
    await expect(transport.getUpdates(credentials, '')).rejects.toBeInstanceOf(ChannelAuthError)
  })

  it('carries retry_after on rate limits', async () => {
    const { fetchImpl } = fetchQueue([{
      status: 429,
      body: { ok: false, error_code: 429, parameters: { retry_after: 3 } },
    }])
    const transport = new TelegramTransport({ fetchImpl })
    const error = await transport.getUpdates(credentials, '').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(TelegramTransportError)
    expect((error as TelegramTransportError).detail.retryAfterMs).toBe(3_000)
  })

  it('maps a tapped inline button to its command and keeps the query id', async () => {
    const { fetchImpl } = fetchQueue([{
      body: {
        ok: true,
        result: [{
          update_id: 30,
          callback_query: {
            id: 'cb-1',
            from: { id: 555 },
            data: '批准 a3f9',
            message: { message_id: 8, date: 1, chat: { id: 555, type: 'private' } },
          },
        }],
      },
    }])
    const transport = new TelegramTransport({ fetchImpl })
    const page = await transport.getUpdates(credentials, '')
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]?.items).toEqual([{ kind: 'text', text: '批准 a3f9' }])
    expect(page.messages[0]?.callbackQueryId).toBe('cb-1')
  })

  it('sends inline buttons and drops callback data over 64 bytes', async () => {
    const { fetchImpl, calls } = fetchQueue([{ body: { ok: true, result: { message_id: 1 } } }])
    const transport = new TelegramTransport({ fetchImpl })
    await transport.sendText(credentials, '555', '要写入文件', {
      buttons: [
        { label: '批准', command: '批准 a3f9' },
        { label: '拒绝', command: '拒绝 a3f9' },
        { label: '太长', command: 'x'.repeat(65) },
      ],
    })
    const body = calls[0]?.body as {
      reply_markup?: { inline_keyboard?: { text: string; callback_data: string }[][] }
    }
    expect(body.reply_markup?.inline_keyboard).toEqual([
      [
        { text: '批准', callback_data: '批准 a3f9' },
        { text: '拒绝', callback_data: '拒绝 a3f9' },
      ],
    ])
  })

  it('answers a callback query to stop the spinner', async () => {
    const { fetchImpl, calls } = fetchQueue([{ body: { ok: true, result: true } }])
    const transport = new TelegramTransport({ fetchImpl })
    await transport.answerCallbackQuery(credentials, 'cb-1')
    expect(calls[0]?.url).toContain('/answerCallbackQuery')
    expect(calls[0]?.body).toMatchObject({ callback_query_id: 'cb-1' })
  })

  it('rejects a malformed token before any request', async () => {
    const { fetchImpl, calls } = fetchQueue([])
    const transport = new TelegramTransport({ fetchImpl })
    await expect(transport.validate({ token: 'bad/token' })).rejects.toBeInstanceOf(ChannelAuthError)
    expect(calls).toHaveLength(0)
  })
})
