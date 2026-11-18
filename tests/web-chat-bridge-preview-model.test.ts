import { describe, expect, it } from 'vitest'
import {
  buildWebChatImportRequest,
  pickDefaultWebChatWorkspace,
  truncatePreviewTurnText,
} from '../src/client/web-chat-bridge/preview-model.ts'
import type { WebChatTranscript } from '../src/host/web-chat-bridge/types.ts'

const sampleTranscript: WebChatTranscript = {
  title: 'Test chat',
  partial: true,
  turns: [
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'hi' },
  ],
  source: {
    kind: 'rendered-capture',
    url: 'https://chat.deepseek.com/s/abc',
    capturedAt: '2026-11-09T00:00:00.000Z',
  },
}

describe('web-chat preview model', () => {
  it('picks the first workspace id', () => {
    expect(pickDefaultWebChatWorkspace([
      { id: 'ws-1', title: 'A', cwd: 'C:/a' },
      { id: 'ws-2', title: 'B', cwd: 'C:/b' },
    ])).toBe('ws-1')
    expect(pickDefaultWebChatWorkspace([])).toBeNull()
  })

  it('builds import RPC payload', () => {
    expect(buildWebChatImportRequest('ws-9', sampleTranscript)).toEqual({
      workspaceId: 'ws-9',
      transcript: sampleTranscript,
    })
  })

  it('truncates long preview text', () => {
    const long = 'x'.repeat(600)
    const cut = truncatePreviewTurnText(long, 100)
    expect(cut.length).toBeLessThanOrEqual(100)
    expect(cut.endsWith('…')).toBe(true)
  })
})
