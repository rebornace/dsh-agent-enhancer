import { describe, expect, it } from 'vitest'
import { BrowserSessionState } from './session-state.ts'

describe('BrowserSessionState tab binding', () => {
  it('lists bound tabs', () => {
    const state = new BrowserSessionState()
    state.bind('a', 3)
    state.bind('b', 7)
    expect([...state.boundTabIds()].sort((x, y) => x - y)).toEqual([3, 7])
  })

  it('drops the binding and the refs of a closed tab', () => {
    const state = new BrowserSessionState()
    state.bind('a', 5)
    state.setLastRefs('a', [1, 2, 3])
    expect(state.hasRef('a', 1)).toBe(true)

    expect(state.unbindTab(5)).toBe('a')
    expect(state.tabOf('a')).toBeUndefined()
    expect(state.sessionOf(5)).toBeUndefined()
    expect(state.hasRef('a', 1)).toBe(false)
    expect(state.boundTabIds()).toEqual([])
  })

  it('reports nothing for a tab no session owns', () => {
    const state = new BrowserSessionState()
    expect(state.unbindTab(9)).toBeUndefined()
  })

  it('keeps other sessions bound when one tab closes', () => {
    const state = new BrowserSessionState()
    state.bind('a', 5)
    state.bind('b', 6)
    state.unbindTab(5)
    expect(state.tabOf('a')).toBeUndefined()
    expect(state.tabOf('b')).toBe(6)
  })

  it('keeps refs with the tab across a switch away and back', () => {
    const state = new BrowserSessionState()
    state.bind('a', 5)
    state.setLastRefs('a', [1, 2])
    state.setLastHrefs('a', new Map([[1, 'https://example.com/one']]))

    state.bind('a', 6)
    expect(state.hasRef('a', 1)).toBe(false)
    expect(state.tabHoldingRef(1)).toBe(5)

    state.bind('a', 5)
    expect(state.hasRef('a', 1)).toBe(true)
    expect(state.hrefOfRef('a', 1)).toBe('https://example.com/one')
  })

  it('never leaks refs to whoever binds the tab next', () => {
    const state = new BrowserSessionState()
    state.bind('a', 5)
    state.setLastRefs('a', [1])

    state.clearSession('a')
    state.bind('b', 5)
    expect(state.hasRef('b', 1)).toBe(false)
  })

  it('prunes memory for tabs that no longer exist', () => {
    const state = new BrowserSessionState()
    state.bind('a', 5)
    state.setLastRefs('a', [1])
    state.bind('a', 6)
    state.setLastRefs('a', [2])

    state.retainTabs([6])
    expect(state.tabHoldingRef(1)).toBeUndefined()
    expect(state.hasRef('a', 2)).toBe(true)
  })
})
