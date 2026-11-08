import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Pending kinds that match workspace sidebar presentation. */
export type RunAlertPendingKind = 'approval' | 'question' | 'plan-review'

export type RunAlertKind = 'finished' | 'pending' | 'error'

export interface RunAlertEvent {
  readonly sessionId: SessionId
  readonly kind: RunAlertKind
  readonly pendingKind?: RunAlertPendingKind
  readonly message?: string
}

export interface SessionStatusFace {
  readonly running?: boolean
  readonly pendingInteraction?: { readonly kind?: string; readonly key?: string } | null
  readonly completionUnread?: boolean
}

export type SessionStatusMap = ReadonlyMap<SessionId, SessionStatusFace>

export type DeliverChannel = 'notification' | 'toast'
