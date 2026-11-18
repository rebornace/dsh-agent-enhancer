import { describe, expect, it } from 'vitest'
import {
  rollbackErrorCodeOf,
  rollbackFailureMessageKey,
} from '../src/client/rollback/failure.ts'
import { CheckpointRollbackClientError } from '../src/client/rollback/remote.ts'

describe('rollback failure mapping', () => {
  it('reads stable codes from CheckpointRollbackClientError only', () => {
    expect(rollbackErrorCodeOf(new CheckpointRollbackClientError('ROLLBACK_CONFLICT')))
      .toBe('ROLLBACK_CONFLICT')
    expect(rollbackErrorCodeOf(new Error('ROLLBACK_CONFLICT'))).toBeUndefined()
    expect(rollbackErrorCodeOf(undefined)).toBeUndefined()
  })

  it('maps each host code to a next-step locale key', () => {
    expect(rollbackFailureMessageKey(undefined)).toBe('rollbackFailed')
    expect(rollbackFailureMessageKey('ROLLBACK_FAILED')).toBe('rollbackFailed')
    expect(rollbackFailureMessageKey('ROLLBACK_UNAVAILABLE')).toBe('rollbackFailedUnavailable')
    expect(rollbackFailureMessageKey('ROLLBACK_CONFLICT')).toBe('rollbackFailedConflict')
    expect(rollbackFailureMessageKey('ROLLBACK_RECOVERY_FAILED')).toBe('rollbackFailedRecovery')
  })
})
