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
  })

  it('reads REQUEST/RESPONSE fragments used by live share API', () => {
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
  it('maps history_messages fragments into a transcript', () => {
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
  })
})
