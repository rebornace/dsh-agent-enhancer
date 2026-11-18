import { describe, expect, it } from 'vitest'
import { BrowserSessionState } from '../src/host/browser-agent/session-state.ts'

describe('BrowserSessionState', () => {
  it('binds session to tab bidirectionally and clears conflict', () => {
    const state = new BrowserSessionState()
    state.bind('s1', 10)
    expect(state.tabOf('s1')).toBe(10)
    expect(state.sessionOf(10)).toBe('s1')
    state.setConflict({ sessionId: 's1', boundTabId: 10, activeTabId: 11 })
    expect(state.currentConflict()?.activeTabId).toBe(11)
    state.bind('s1', 11)
    expect(state.currentConflict()).toBeNull()
    expect(state.tabOf('s1')).toBe(11)
  })

  it('tracks needsHuman and audit per session', () => {
    const state = new BrowserSessionState()
    state.setNeedsHuman('s1', 'login')
    expect(state.anyNeedsHuman()?.sessionId).toBe('s1')
    state.record({
      sessionId: 's1',
      tool: 'browser_navigate',
      summary: 'Navigate',
      outcome: 'ok',
      url: 'https://example.com',
    })
    expect(state.recentAudit(1)[0]?.tool).toBe('browser_navigate')
    state.clearSession('s1')
    expect(state.needsHuman('s1')).toBeUndefined()
    expect(state.recentAudit()).toHaveLength(0)
  })

  it('stores per-ref href for same-ref click recovery only', () => {
    const state = new BrowserSessionState()
    state.setLastRefs('s1', [52])
    state.setLastHrefs('s1', new Map([[52, 'https://example.com/item/1']]))
    expect(state.hrefOfRef('s1', 52)).toBe('https://example.com/item/1')
    expect(state.hrefOfRef('s1', 99)).toBeUndefined()
    state.clearLastRefs('s1')
    expect(state.hrefOfRef('s1', 52)).toBeUndefined()
  })

  it('blocks re-click of dead refs until a fresh snapshot', () => {
    const state = new BrowserSessionState()
    state.setLastRefs('s1', [48])
    state.markDeadClickRef('s1', 48)
    expect(state.isDeadClickRef('s1', 48)).toBe(true)
    state.setLastRefs('s1', [48, 49])
    expect(state.isDeadClickRef('s1', 48)).toBe(false)
  })

  it('remembers accessible names for name-matched recovery', () => {
    const state = new BrowserSessionState()
    state.setLastRefs('s1', [52])
    state.setLastNames('s1', new Map([[52, '我开个救护车怎么这么惨']]))
    expect(state.nameOfRef('s1', 52)).toBe('我开个救护车怎么这么惨')
    state.clearLastRefs('s1')
    expect(state.nameOfRef('s1', 52)).toBeUndefined()
  })
})
