import { describe, expect, it } from 'vitest'
import {
  importWebChatHistoryRequestSchema,
  resolveWebChatShareLinkResultSchema,
  webChatTranscriptSchema,
} from '../rpc.ts'
import { parseWebChatShareContent, webChatSharePageUrl } from './share-link.ts'

describe('webChatTranscriptSchema rich wire', () => {
  it('accepts share transcripts that carry fragment messages', () => {
    const transcript = parseWebChatShareContent({
      code: 0,
      data: {
        biz_data: {
          title: 'Wire chat',
          messages: [
            {
              role: 'USER',
              fragments: [{ type: 'REQUEST', content: 'hi' }],
            },
            {
              role: 'ASSISTANT',
              fragments: [
                { type: 'THINK', content: '…', elapsed_secs: null },
                {
                  type: 'TOOL_SEARCH',
                  queries: ['q'],
                  results: [{ url: 'https://example.com', title: 'T', snippet: null }],
                  status: 'FINISHED',
                },
                { type: 'RESPONSE', content: 'hello' },
              ],
            },
          ],
        },
      },
    }, {
      shareId: 'abc123',
      shareUrl: webChatSharePageUrl('abc123'),
    })

    expect(() => webChatTranscriptSchema.parse(transcript)).not.toThrow()
    expect(() => resolveWebChatShareLinkResultSchema.parse({ transcript })).not.toThrow()
    expect(() => importWebChatHistoryRequestSchema.parse({
      workspaceId: 'ws-1',
      transcript,
    })).not.toThrow()
  })

  it('still accepts flat DOM-style transcripts without messages', () => {
    expect(() => webChatTranscriptSchema.parse({
      title: 'Flat',
      partial: true,
      turns: [
        { role: 'user', text: 'a' },
        { role: 'assistant', text: 'b' },
      ],
      source: {
        kind: 'rendered-capture',
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
    })).not.toThrow()
  })
})
