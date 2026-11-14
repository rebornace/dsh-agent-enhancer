import { describe, expect, it } from 'vitest'
import {
  extractWebChatShareId,
  parseWebChatHistoryMessages,
  parseWebChatSessionList,
  parseWebChatShareContent,
  webChatSharePageUrl,
} from './share-link.ts'

describe('extractWebChatShareId', () => {
  it('parses full share URLs and bare ids', () => {
    expect(extractWebChatShareId('https://chat.deepseek.com/share/nvy7v2ps1r6e2wyoyj'))
      .toBe('nvy7v2ps1r6e2wyoyj')
    expect(extractWebChatShareId('https://chat.deepseek.com/share/83e4cugwvarusw6dth'))
      .toBe('83e4cugwvarusw6dth')
    expect(extractWebChatShareId('nvy7v2ps1r6e2wyoyj')).toBe('nvy7v2ps1r6e2wyoyj')
    expect(extractWebChatShareId('https://example.com/x')).toBeNull()
  })
})

describe('parseWebChatShareContent', () => {
  it('maps public share API messages into turns', () => {
    const transcript = parseWebChatShareContent({
      code: 0,
      data: {
        biz_data: {
          title: 'Hello share',
          messages: [
            { role: 'USER', content: 'hi' },
            { role: 'ASSISTANT', content: 'hello' },
          ],
        },
      },
    }, {
      shareId: 'abc123',
      shareUrl: webChatSharePageUrl('abc123'),
    })
    expect(transcript.title).toBe('Hello share')
    expect(transcript.source.kind).toBe('share-link')
    expect(transcript.turns).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ])
    expect(transcript.messages).toHaveLength(2)
  })

  it('keeps THINK / TOOL_SEARCH in rich messages while preview stays RESPONSE-only', () => {
    const transcript = parseWebChatShareContent({
      code: 0,
      data: {
        biz_data: {
          title: 'Shared Conversation',
          messages: [
            {
              role: 'USER',
              fragments: [{ type: 'REQUEST', content: '起个名字' }],
            },
            {
              role: 'ASSISTANT',
              fragments: [
                { type: 'THINK', content: '先想一下…' },
                {
                  type: 'TOOL_SEARCH',
                  queries: ['name'],
                  results: [{ url: 'https://example.com', title: 'Ex' }],
                  status: 'FINISHED',
                },
                { type: 'RESPONSE', content: '虚舟' },
                { type: 'TIP', content: '提示' },
              ],
            },
          ],
        },
      },
    }, {
      shareId: '83e4cugwvarusw6dth',
      shareUrl: webChatSharePageUrl('83e4cugwvarusw6dth'),
    })
    expect(transcript.turns).toEqual([
      { role: 'user', text: '起个名字' },
      { role: 'assistant', text: '虚舟' },
    ])
    const assistant = transcript.messages?.[1]
    expect(assistant?.fragments.map(frag => frag.type)).toEqual([
      'THINK',
      'TOOL_SEARCH',
      'RESPONSE',
    ])
  })

  it('prefers message_id / parent_id from public share payloads', () => {
    const transcript = parseWebChatShareContent({
      code: 0,
      data: {
        biz_data: {
          title: 'Shared ids',
          current_message_id: 20,
          messages: [
            {
              message_id: 10,
              parent_id: null,
              role: 'USER',
              fragments: [{ type: 'REQUEST', content: 'q' }],
            },
            {
              message_id: '20',
              parent_id: '10',
              role: 'ASSISTANT',
              fragments: [{ type: 'RESPONSE', content: 'a' }],
            },
          ],
        },
      },
    }, {
      shareId: 'msgidtest',
      shareUrl: webChatSharePageUrl('msgidtest'),
    })
    expect(transcript.messages?.map(m => m.id)).toEqual([10, 20])
    expect(transcript.messages?.[1]?.parent_id).toBe(10)
    expect(transcript.currentMessageId).toBe(20)
  })
})

describe('parseWebChatSessionList', () => {
  it('maps fetch_page chat_sessions', () => {
    const result = parseWebChatSessionList({
      code: 0,
      data: {
        biz_data: {
          chat_sessions: [
            { id: 's1', title: 'One', updated_at: 1 },
            { id: 's2', title: 'Two' },
          ],
          has_more: true,
        },
      },
    })
    expect(result.hasMore).toBe(true)
    expect(result.items).toEqual([
      { id: 's1', title: 'One', updatedAt: 1 },
      { id: 's2', title: 'Two' },
    ])
  })
})

describe('parseWebChatHistoryMessages', () => {
  it('maps history_messages fragments into a rich transcript', () => {
    const transcript = parseWebChatHistoryMessages({
      code: 0,
      data: {
        biz_data: {
          chat_session: { title: 'History title' },
          chat_messages: [
            {
              role: 'USER',
              fragments: [{ type: 'REQUEST', content: 'ping' }],
            },
            {
              role: 'ASSISTANT',
              fragments: [{ type: 'RESPONSE', content: 'pong' }],
            },
          ],
        },
      },
    }, { chatSessionId: 'sess-1' })
    expect(transcript.title).toBe('History title')
    expect(transcript.source.kind).toBe('account-history')
    expect(transcript.turns).toEqual([
      { role: 'user', text: 'ping' },
      { role: 'assistant', text: 'pong' },
    ])
    expect(transcript.messages).toHaveLength(2)
  })
})
