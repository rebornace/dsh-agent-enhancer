import { describe, expect, it } from 'vitest'
import { BrowserApprovalGate } from '../src/host/browser-agent/approval.ts'
import { BrowserSessionState } from '../src/host/browser-agent/session-state.ts'

describe('session lastHttpUrl + approval sticky origin', () => {
  it('remembers allow-origin using lastHttpUrl when the live page URL is blank', async () => {
    const sessions = new BrowserSessionState()
    const gate = new BrowserApprovalGate()
    sessions.rememberHttpUrl('s1', 'https://example.com/feed')

    const first = gate.requestApproval({
      sessionId: 's1',
      tool: 'browser_click',
      summary: 'Click ref 1',
      url: sessions.lastHttpUrl('s1'),
      signal: new AbortController().signal,
    })
    gate.resolve(gate.current()!.id, 'allow-origin')
    await expect(first).resolves.toBe('allow')

    await expect(gate.requestApproval({
      sessionId: 's1',
      tool: 'browser_scroll',
      summary: 'Scroll',
      // Simulate about:blank / missing pageStatus — tools fall back to lastHttpUrl.
      url: sessions.lastHttpUrl('s1'),
      signal: new AbortController().signal,
    })).resolves.toBe('allow')
    expect(gate.current()).toBeNull()
  })
})
