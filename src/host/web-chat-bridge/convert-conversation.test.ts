import { describe, expect, it } from 'vitest'
import {
  convertWebChatConversation,
  selectWebChatBranch,
  WebChatConvertError,
} from './convert-conversation.ts'
import type { WebChatRichMessage } from './fragments.ts'
import { buildWebChatImportSeed } from './import-session.ts'
import type { WebChatTranscript } from './types.ts'

function msg(
  partial: Omit<WebChatRichMessage, 'status' | 'parent_id'> & {
    status?: string
    parent_id?: number | null
  },
): WebChatRichMessage {
  return {
    parent_id: partial.parent_id ?? null,
    status: partial.status ?? 'FINISHED',
    ...partial,
  }
}

describe('selectWebChatBranch', () => {
  it('returns linear messages when no parent links exist', () => {
    const messages = [
      msg({ id: 1, role: 'USER', fragments: [{ type: 'REQUEST', content: 'a' }] }),
      msg({ id: 2, role: 'ASSISTANT', fragments: [{ type: 'RESPONSE', content: 'b' }] }),
    ]
    expect(selectWebChatBranch(messages)).toEqual(messages)
  })

  it('follows current_message_id through a tree', () => {
    const messages = [
      msg({ id: 1, role: 'USER', fragments: [{ type: 'REQUEST', content: 'q1' }] }),
      msg({
        id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        fragments: [{ type: 'RESPONSE', content: 'a1' }],
      }),
      msg({
        id: 3,
        parent_id: 1,
        role: 'USER',
        fragments: [{ type: 'REQUEST', content: 'q2' }],
      }),
      msg({
        id: 4,
        parent_id: 3,
        role: 'ASSISTANT',
        fragments: [{ type: 'RESPONSE', content: 'a2' }],
      }),
    ]
    const branch = selectWebChatBranch(messages, 4)
    expect(branch.map(m => m.id)).toEqual([1, 3, 4])
  })

  it('drops orphan parent_id and keeps array order (share-safe)', () => {
    const messages = [
      msg({ id: 1, role: 'USER', fragments: [{ type: 'REQUEST', content: 'a' }] }),
      msg({
        id: 2,
        parent_id: 999,
        role: 'ASSISTANT',
        fragments: [{ type: 'RESPONSE', content: 'b' }],
      }),
    ]
    const branch = selectWebChatBranch(messages)
    expect(branch.map(m => m.id)).toEqual([1, 2])
    expect(branch[1]?.parent_id).toBeNull()
  })

  it('falls back to array order on duplicate ids', () => {
    const messages = [
      msg({ id: 1, role: 'USER', fragments: [{ type: 'REQUEST', content: 'a' }] }),
      msg({ id: 1, role: 'ASSISTANT', fragments: [{ type: 'RESPONSE', content: 'b' }] }),
    ]
    expect(selectWebChatBranch(messages).map(m => m.role)).toEqual(['USER', 'ASSISTANT'])
  })
})

describe('convertWebChatConversation', () => {
  it('maps THINK into reasoning and RESPONSE into text', () => {
    const converted = convertWebChatConversation({
      title: 'Think chat',
      messages: [
        msg({ id: 1, role: 'USER', fragments: [{ type: 'REQUEST', content: 'hi' }] }),
        msg({
          id: 2,
          role: 'ASSISTANT',
          fragments: [
            { type: 'THINK', content: 'ponder', elapsed_secs: 1.5 },
            { type: 'RESPONSE', content: 'hello' },
          ],
        }),
      ],
    }, { createId: () => 'id' })

    const assistant = converted.events.find(event => event.type === 'assistant/message')
    expect(assistant).toBeDefined()
    const message = (assistant!.data as unknown as { message: { content: readonly unknown[] } }).message
    expect(message.content).toEqual([
      { type: 'reasoning', text: 'ponder' },
      { type: 'text', text: 'hello' },
    ])
    expect(converted.events.some(event => event.type === 'session/title')).toBe(true)
  })

  it('maps TOOL_SEARCH and TOOL_OPEN into web_search / web_fetch', () => {
    const converted = convertWebChatConversation({
      title: null,
      messages: [
        msg({ id: 1, role: 'USER', fragments: [{ type: 'REQUEST', content: 'search' }] }),
        msg({
          id: 2,
          role: 'ASSISTANT',
          fragments: [
            {
              type: 'TOOL_SEARCH',
              queries: ['DeepSeek'],
              results: [{ url: 'https://example.com', title: 'Example', snippet: 'snip' }],
              status: 'FINISHED',
            },
            {
              type: 'TOOL_OPEN',
              status: 'FINISHED',
              url: 'https://example.com',
              title: 'Example',
            },
            { type: 'RESPONSE', content: 'done' },
          ],
        }),
      ],
    }, { createId: () => crypto.randomUUID() })

    const calls = converted.events.filter(event => event.type === 'tool/call')
    expect(calls.map(event => (event.data as { name: string }).name)).toEqual([
      'web_search',
      'web_fetch',
    ])
    expect(converted.events.some(event => event.type === 'tool/result')).toBe(true)
  })

  it('skips CONTENT_FILTER turns', () => {
    expect(() => convertWebChatConversation({
      title: null,
      messages: [
        msg({ id: 1, role: 'USER', fragments: [{ type: 'REQUEST', content: 'bad' }] }),
        msg({
          id: 2,
          role: 'ASSISTANT',
          status: 'CONTENT_FILTER',
          fragments: [{ type: 'RESPONSE', content: 'blocked' }],
        }),
      ],
    })).toThrow(WebChatConvertError)
  })

  it('turns READ_LINK into markdown link lines', () => {
    const converted = convertWebChatConversation({
      title: null,
      messages: [
        msg({ id: 1, role: 'USER', fragments: [{ type: 'REQUEST', content: 'link' }] }),
        msg({
          id: 2,
          role: 'ASSISTANT',
          fragments: [
            {
              type: 'READ_LINK',
              results: [{ url: 'https://a.example', title: 'A' }],
            },
            { type: 'RESPONSE', content: 'ok' },
          ],
        }),
      ],
    }, { createId: () => 'x' })

    const assistant = converted.events.find(event => event.type === 'assistant/message')
    const content = (assistant!.data as unknown as {
      message: { content: readonly { type: string; text: string }[] }
    }).message.content
    expect(content.some(block => block.type === 'text' && block.text.includes('[A](https://a.example)')))
      .toBe(true)
  })

  it('ends unfinished replies with an error turn', () => {
    const converted = convertWebChatConversation({
      title: null,
      messages: [
        msg({ id: 1, role: 'USER', fragments: [{ type: 'REQUEST', content: 'q' }] }),
        msg({
          id: 2,
          role: 'ASSISTANT',
          status: 'FAILED',
          fragments: [{ type: 'RESPONSE', content: 'partial' }],
        }),
      ],
    }, { createId: () => 'y' })

    const end = converted.events.find(event => event.type === 'turn/end')
    expect(end).toMatchObject({
      data: {
        reason: {
          kind: 'error',
          error: { code: 'DEEPSEEK_EXPORT_FAILED' },
        },
      },
    })
    expect(converted.events.some(event => event.type === 'assistant/message')).toBe(false)
  })
})

describe('buildWebChatImportSeed rich path', () => {
  it('emits reasoning and tool calls from a rich transcript', () => {
    const transcript: WebChatTranscript = {
      title: 'Rich',
      turns: [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'hello' },
      ],
      messages: [
        msg({ id: 1, role: 'USER', fragments: [{ type: 'REQUEST', content: 'hi' }] }),
        msg({
          id: 2,
          role: 'ASSISTANT',
          fragments: [
            { type: 'THINK', content: 't' },
            {
              type: 'TOOL_SEARCH',
              queries: ['q'],
              results: [{ url: 'https://example.com', title: 'T' }],
              status: 'FINISHED',
            },
            { type: 'RESPONSE', content: 'hello' },
          ],
        }),
      ],
      partial: false,
      source: {
        kind: 'share-link',
        capturedAt: '2026-01-01T00:00:00.000Z',
        chatSessionId: 'abc',
      },
    }

    const seed = buildWebChatImportSeed(transcript)
    expect(seed.some(event => event.type === 'system/message')).toBe(true)
    const assistant = seed.find(event => event.type === 'assistant/message')
    const content = (assistant!.data as unknown as {
      message: { content: readonly { type: string }[] }
    }).message.content
    expect(content.some(block => block.type === 'reasoning')).toBe(true)
    expect(content.some(block => block.type === 'tool-call')).toBe(true)
    expect(seed.some(event =>
      event.type === 'tool/call'
      && (event.data as { name: string }).name === 'web_search',
    )).toBe(true)
  })
})
