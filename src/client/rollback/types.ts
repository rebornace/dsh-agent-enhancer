import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CheckpointRollbackErrorCode,
  CheckpointRollbackOperation,
  CheckpointRollbackPreview,
  CheckpointRollbackRequest,
  CheckpointRollbackResult,
  CheckpointRollbackScope,
  CheckpointSummariesRequest,
  CheckpointSummariesResult,
  CheckpointTurnSummary,
} from '../../host/checkpoint/service.ts'
export type { CheckpointTurnSummary }

export interface RollbackRemote {
  preview(request: CheckpointRollbackRequest, signal: AbortSignal): Promise<CheckpointRollbackPreview>
  execute(request: CheckpointRollbackRequest, signal: AbortSignal): Promise<CheckpointRollbackResult>
  summaries?(request: CheckpointSummariesRequest, signal: AbortSignal): Promise<CheckpointSummariesResult>
}

/** Which UI surface owns the confirm modal for the active restore. */
export type RollbackModalSurface = 'composer' | 'timeline'

export interface RollbackActive {
  readonly turn: number
  readonly operation: CheckpointRollbackOperation
  readonly status: 'loading' | 'ready' | 'executing' | 'error'
  readonly preview?: CheckpointRollbackPreview
  readonly scope?: CheckpointRollbackScope
  readonly error?: 'preview' | 'execute'
  /** Stable host failure category when `status` is `error`. */
  readonly errorCode?: CheckpointRollbackErrorCode
  readonly version: number
  /**
   * Confirm modal owner. Timeline opens must render beside the right pane —
   * the composer overlay host is often not the visible subscriber there.
   */
  readonly surface: RollbackModalSurface
}

export interface RollbackSnapshot {
  readonly enabled: boolean
  readonly active: RollbackActive | null
  /** Turn → lightweight checkpoint card for restore affordances. */
  readonly coverageByTurn: Readonly<Record<number, CheckpointTurnSummary>>
}

export type RollbackDraftActions = Pick<InputActions, 'setDraft' | 'persistDraft'>

export interface RollbackControllerOptions {
  readonly sessionId: SessionId
  readonly enabled: () => boolean
  readonly remote: RollbackRemote
}
