import {
  blockingUnavailable,
} from '../../host/checkpoint/availability.ts'
import type {
  CheckpointRollbackScope,
  CheckpointUnavailable,
} from '../../host/checkpoint/availability.ts'

export type { CheckpointRollbackScope }

export function confirmBlocked(
  unavailable: readonly CheckpointUnavailable[],
  conflicts: readonly unknown[],
  scope: CheckpointRollbackScope,
  trackedFiles = 0,
  options: { readonly shadowRestore?: boolean } = {},
): boolean {
  if (blockingUnavailable(unavailable, scope, { trackedFiles }).length > 0) return true
  if (options.shadowRestore === true) return false
  return scope === 'conversation-and-files' && conflicts.length > 0
}

export function scopeLabel(
  scope: CheckpointRollbackScope | undefined,
): CheckpointRollbackScope {
  return scope ?? 'conversation-and-files'
}
