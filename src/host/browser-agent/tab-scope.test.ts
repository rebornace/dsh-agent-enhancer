import { describe, expect, it } from 'vitest'
import { TabScopeStore } from './tab-scope.ts'

describe('TabScopeStore', () => {
  it('tracks read-only state per tab', () => {
    const scope = new TabScopeStore()
    expect(scope.isReadOnly(3)).toBe(false)

    scope.setReadOnly(3, true)
    expect(scope.isReadOnly(3)).toBe(true)
    expect(scope.isReadOnly(4)).toBe(false)

    scope.setReadOnly(3, false)
    expect(scope.isReadOnly(3)).toBe(false)
  })

  it('treats an unknown tab as writable', () => {
    const scope = new TabScopeStore()
    expect(scope.isReadOnly(undefined)).toBe(false)
  })

  it('drops scopes for closed tabs', () => {
    const scope = new TabScopeStore()
    scope.setReadOnly(2, true)
    scope.setReadOnly(5, true)

    scope.retain([5])
    expect(scope.isReadOnly(2)).toBe(false)
    expect(scope.isReadOnly(5)).toBe(true)
  })

  it('explains the refusal without leaking the page', () => {
    const scope = new TabScopeStore()
    scope.setReadOnly(7, true)
    const message = scope.refusal(7)
    expect(message).toContain('tab_read_only')
    expect(message).toContain('tab 7')
    expect(message).toContain('browser_snapshot')
    expect(message).toContain('browser_navigate')
  })
})
