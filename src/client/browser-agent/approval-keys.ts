/**
 * Keyboard decision for the browser approval card.
 *
 * Kept free of React so the guard rules are testable: a shortcut must never
 * fire while the user is typing somewhere else in the app, and Enter on a
 * focused button belongs to that button.
 */

export interface ApprovalKeyInput {
  readonly key: string
  readonly tagName?: string
  readonly contentEditable?: boolean
  readonly busy?: boolean
  readonly defaultPrevented?: boolean
  readonly metaKey?: boolean
  readonly ctrlKey?: boolean
  readonly altKey?: boolean
}

export type ApprovalKeyDecision = 'allow' | 'deny' | null

export function approvalKeyDecision(input: ApprovalKeyInput): ApprovalKeyDecision {
  if (input.busy === true) return null
  if (input.defaultPrevented === true) return null
  if (input.metaKey === true || input.ctrlKey === true || input.altKey === true) return null
  const tag = input.tagName ?? ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return null
  if (input.contentEditable === true) return null
  if (input.key === 'Escape') return 'deny'
  if (input.key === 'Enter' && tag !== 'BUTTON') return 'allow'
  return null
}
