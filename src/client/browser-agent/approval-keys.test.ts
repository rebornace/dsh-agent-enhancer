import { describe, expect, it } from 'vitest'
import { approvalKeyDecision } from './approval-keys.ts'

describe('approvalKeyDecision', () => {
  it('allows on Enter and denies on Escape when nothing is being typed', () => {
    expect(approvalKeyDecision({ key: 'Enter' })).toBe('allow')
    expect(approvalKeyDecision({ key: 'Escape' })).toBe('deny')
  })

  it('never decides while the user types elsewhere', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'DIV']) {
      const contentEditable = tagName === 'DIV'
      expect(approvalKeyDecision({ key: 'Enter', tagName, contentEditable }), tagName).toBeNull()
      expect(approvalKeyDecision({ key: 'Escape', tagName, contentEditable }), tagName).toBeNull()
    }
  })

  it('leaves Enter to a focused button but still lets Escape deny', () => {
    expect(approvalKeyDecision({ key: 'Enter', tagName: 'BUTTON' })).toBeNull()
    expect(approvalKeyDecision({ key: 'Escape', tagName: 'BUTTON' })).toBe('deny')
  })

  it('ignores shortcuts while the decision is in flight or with modifiers held', () => {
    expect(approvalKeyDecision({ key: 'Enter', busy: true })).toBeNull()
    expect(approvalKeyDecision({ key: 'Enter', ctrlKey: true })).toBeNull()
    expect(approvalKeyDecision({ key: 'Enter', metaKey: true })).toBeNull()
    expect(approvalKeyDecision({ key: 'Enter', altKey: true })).toBeNull()
  })

  it('ignores keys another handler already consumed', () => {
    expect(approvalKeyDecision({ key: 'Enter', defaultPrevented: true })).toBeNull()
    expect(approvalKeyDecision({ key: 'Escape', defaultPrevented: true })).toBeNull()
  })

  it('ignores unrelated keys', () => {
    expect(approvalKeyDecision({ key: 'a' })).toBeNull()
    expect(approvalKeyDecision({ key: 'Tab' })).toBeNull()
  })
})
