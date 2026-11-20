import { describe, expect, it, vi, afterEach } from 'vitest'
import { BrowserApprovalGate } from './approval.ts'

describe('origin grants', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('covers a bounded number of actions on one origin', () => {
    const gate = new BrowserApprovalGate()
    expect(gate.grantOrigin({ sessionId: 's1', url: 'https://example.com/admin', ttlMs: 60_000, actions: 2 })).toBe(true)
    expect(gate.isPreauthorized('s1', 'https://example.com/other')).toBe(true)
    expect(gate.isPreauthorized('s1', 'https://example.com/third')).toBe(true)
    // Budget exhausted: the next call goes back to the card.
    expect(gate.isPreauthorized('s1', 'https://example.com/fourth')).toBe(false)
  })

  it('does not leak across sessions or sites', () => {
    const gate = new BrowserApprovalGate()
    gate.grantOrigin({ sessionId: 's1', url: 'https://example.com', ttlMs: 60_000, actions: 5 })
    expect(gate.isPreauthorized('s2', 'https://example.com/x')).toBe(false)
    expect(gate.isPreauthorized('s1', 'https://other.example/x')).toBe(false)
  })

  it('expires by time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'))
    const gate = new BrowserApprovalGate()
    gate.grantOrigin({ sessionId: 's1', url: 'https://example.com', ttlMs: 1_000, actions: 5 })
    expect(gate.isPreauthorized('s1', 'https://example.com/x')).toBe(true)
    vi.advanceTimersByTime(1_500)
    expect(gate.isPreauthorized('s1', 'https://example.com/x')).toBe(false)
    expect(gate.activeGrants()).toHaveLength(0)
  })

  it('revokes one origin without touching the others', () => {
    const gate = new BrowserApprovalGate()
    gate.grantOrigin({ sessionId: 's1', url: 'https://a.example', ttlMs: 60_000, actions: 5 })
    gate.grantOrigin({ sessionId: 's1', url: 'https://b.example', ttlMs: 60_000, actions: 5 })
    expect(gate.revokeOrigin({ sessionId: 's1', url: 'https://a.example/path' })).toBe(true)
    expect(gate.isPreauthorized('s1', 'https://a.example/x')).toBe(false)
    expect(gate.isPreauthorized('s1', 'https://b.example/x')).toBe(true)
    expect(gate.revokeOrigin({ sessionId: 's1', url: 'https://missing.example' })).toBe(false)
  })

  it('drops grants with the session and refuses non-http targets', () => {
    const gate = new BrowserApprovalGate()
    gate.grantOrigin({ sessionId: 's1', url: 'https://example.com', ttlMs: 60_000, actions: 5 })
    gate.clearSession('s1')
    expect(gate.isPreauthorized('s1', 'https://example.com/x')).toBe(false)
    expect(gate.grantOrigin({ sessionId: 's1', url: 'about:blank', ttlMs: 60_000, actions: 5 })).toBe(false)
    expect(gate.grantOrigin({ sessionId: 's1', url: 'https://example.com', ttlMs: 0, actions: 5 })).toBe(false)
  })
})
