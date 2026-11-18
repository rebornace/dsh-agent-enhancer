import { describe, expect, it } from 'vitest'
import { BrowserApprovalGate } from '../src/host/browser-agent/approval.ts'

describe('BrowserApprovalGate', () => {
  it('holds mutating actions until allow-once', async () => {
    const gate = new BrowserApprovalGate()
    const controller = new AbortController()
    const pending = gate.requestApproval({
      sessionId: 's1',
      tool: 'browser_click',
      summary: 'Click ref 1',
      url: 'https://example.com/a',
      signal: controller.signal,
    })
    expect(gate.current()?.tool).toBe('browser_click')
    expect(gate.resolve(gate.current()!.id, 'allow-once')).toBe(true)
    await expect(pending).resolves.toBe('allow')
    expect(gate.current()).toBeNull()
    expect(gate.isPreauthorized('s1', 'https://example.com/b')).toBe(false)
  })

  it('remembers origin for the session after allow-origin', async () => {
    const gate = new BrowserApprovalGate()
    const first = gate.requestApproval({
      sessionId: 's1',
      tool: 'browser_navigate',
      summary: 'Navigate',
      url: 'https://example.com/login',
      signal: new AbortController().signal,
    })
    gate.resolve(gate.current()!.id, 'allow-origin')
    await expect(first).resolves.toBe('allow')
    expect(gate.isPreauthorized('s1', 'https://example.com/home')).toBe(true)
    await expect(gate.requestApproval({
      sessionId: 's1',
      tool: 'browser_click',
      summary: 'Click',
      url: 'https://example.com/home',
      signal: new AbortController().signal,
    })).resolves.toBe('allow')
    expect(gate.isPreauthorized('s2', 'https://example.com/home')).toBe(false)
  })

  it('allow-once does not remember the origin', async () => {
    const gate = new BrowserApprovalGate()
    const first = gate.requestApproval({
      sessionId: 's1',
      tool: 'browser_type',
      summary: 'Type',
      url: 'https://app.example.com/x',
      signal: new AbortController().signal,
    })
    gate.resolve(gate.current()!.id, 'allow-once')
    await expect(first).resolves.toBe('allow')
    expect(gate.isPreauthorized('s1', 'https://app.example.com/y')).toBe(false)
  })

  it('forcePrompt still prompts when origin is already allowed for the session', async () => {
    const gate = new BrowserApprovalGate()
    const first = gate.requestApproval({
      sessionId: 's1',
      tool: 'browser_navigate',
      summary: 'Navigate',
      url: 'https://trusted.example/path',
      signal: new AbortController().signal,
    })
    gate.resolve(gate.current()!.id, 'allow-origin')
    await expect(first).resolves.toBe('allow')

    const pending = gate.requestApproval({
      sessionId: 's1',
      tool: 'browser_open_url',
      summary: 'Open',
      url: 'https://trusted.example/x',
      signal: new AbortController().signal,
      forcePrompt: true,
    })
    expect(gate.current()?.tool).toBe('browser_open_url')
    expect(gate.resolve(gate.current()!.id, 'allow-once')).toBe(true)
    await expect(pending).resolves.toBe('allow')
  })

  it('deny rejects the action and clearSession cancels waiters', async () => {
    const gate = new BrowserApprovalGate()
    const denied = gate.requestApproval({
      sessionId: 's1',
      tool: 'browser_scroll',
      summary: 'Scroll',
      url: 'https://example.com',
      signal: new AbortController().signal,
    })
    gate.resolve(gate.current()!.id, 'deny')
    await expect(denied).resolves.toBe('deny')

    const cancelled = gate.requestApproval({
      sessionId: 's1',
      tool: 'browser_click',
      summary: 'Click',
      url: 'https://example.com',
      signal: new AbortController().signal,
    })
    gate.clearSession('s1')
    await expect(cancelled).rejects.toThrow(/session cleared/)
  })
})
