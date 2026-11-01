import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CheckpointRollbackPreview,
  CheckpointRollbackRequest,
  CheckpointRollbackResult,
} from '../../host/checkpoint/service.ts'

export interface RollbackRemote {
  preview(request: CheckpointRollbackRequest, signal: AbortSignal): Promise<CheckpointRollbackPreview>
  execute(request: CheckpointRollbackRequest, signal: AbortSignal): Promise<CheckpointRollbackResult>
}

export interface RollbackActive {
  readonly turn: number
  readonly status: 'loading' | 'ready' | 'executing' | 'error'
  readonly preview?: CheckpointRollbackPreview
  readonly error?: 'preview' | 'execute'
  readonly version: number
}

export interface RollbackSnapshot {
  readonly enabled: boolean
  readonly active: RollbackActive | null
}

export type RollbackDraftActions = Pick<InputActions, 'setDraft' | 'persistDraft'>

export interface RollbackControllerOptions {
  readonly sessionId: SessionId
  readonly enabled: () => boolean
  readonly remote: RollbackRemote
}
