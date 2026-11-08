import type { RunAlertPendingKind } from './types.ts'

/** Match official workspace `visiblePendingKind` — only user-facing waits. */
export function visiblePendingKind(kind: string | undefined): RunAlertPendingKind | undefined {
  switch (kind) {
    case 'approval':
    case 'plan-review':
    case 'question':
      return kind
    default:
      return undefined
  }
}
