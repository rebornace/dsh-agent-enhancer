import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CheckpointRollbackErrorCode } from '../../host/checkpoint/service.ts'
import { CheckpointRollbackClientError } from './remote.ts'

export type RollbackFailureLocaleKey = Parameters<TranslateNS<'agent-enhancer'>>[0]

export function rollbackErrorCodeOf(error: unknown): CheckpointRollbackErrorCode | undefined {
  return error instanceof CheckpointRollbackClientError ? error.code : undefined
}

/** Map host rollback failure codes to localized copy with a next step. */
export function rollbackFailureMessageKey(
  code: CheckpointRollbackErrorCode | undefined,
): RollbackFailureLocaleKey {
  switch (code) {
    case 'ROLLBACK_UNAVAILABLE':
      return 'rollbackFailedUnavailable'
    case 'ROLLBACK_CONFLICT':
      return 'rollbackFailedConflict'
    case 'ROLLBACK_RECOVERY_FAILED':
      return 'rollbackFailedRecovery'
    case 'ROLLBACK_FAILED':
    case undefined:
      return 'rollbackFailed'
    default: {
      const _exhaustive: never = code
      return _exhaustive
    }
  }
}
