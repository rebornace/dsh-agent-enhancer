export type CheckpointRollbackScope = 'conversation' | 'conversation-and-files'

export type CheckpointUnavailable =
  | 'checkpoint-not-found'
  | 'incomplete-checkpoint'
  | 'prompt-non-text-content'
  | 'workspace-capture-failed'
  | 'session-changed'
  | 'session-running'
  | 'permission-denied'
  | 'rollback-disabled'
  | 'first-turn'
  | 'incompatible-session'
  | 'compacted-surface'
  | 'subagent-session'
  | 'unknown-surface'

/** Soft gaps that must not block conversation-only restore (draft may be empty). */
const CONVERSATION_SOFT = new Set<CheckpointUnavailable>([
  'incomplete-checkpoint',
  'workspace-capture-failed',
  'prompt-non-text-content',
  // Official compaction / foreign replaces in the rolled-back region should not
  // block restoring the conversation draft and surface tip.
  'compacted-surface',
  // Conversation restore does not need a workspace cwd.
  'permission-denied',
  // Turn 1 is restorable; keep this soft for older previews that still emit it.
  'first-turn',
  // Non-contiguous logs are unusual but still restorable when a surface was built.
  // Only emit unknown-surface when surface is missing — that case stays hard.
])

/**
 * Soft gaps that must not block full restore when the checkpoint has no tracked
 * files to write (cancelled turns, no edits, capture noise).
 */
const EMPTY_FILES_SOFT = new Set<CheckpointUnavailable>([
  'incomplete-checkpoint',
  'workspace-capture-failed',
  'prompt-non-text-content',
  'compacted-surface',
])

export interface BlockingUnavailableOptions {
  readonly trackedFiles?: number
}

export function blockingUnavailable(
  unavailable: readonly CheckpointUnavailable[],
  scope: CheckpointRollbackScope,
  options: BlockingUnavailableOptions = {},
): readonly CheckpointUnavailable[] {
  const trackedFiles = options.trackedFiles
  const soft = scope === 'conversation' || trackedFiles === 0
    ? (scope === 'conversation' ? CONVERSATION_SOFT : EMPTY_FILES_SOFT)
    : null
  if (soft === null) return unavailable
  return unavailable.filter(reason => !soft.has(reason))
}

/** Reasons that never block conversation-only restore (UI should not call them fatal). */
export function isConversationSoftUnavailable(reason: CheckpointUnavailable): boolean {
  return CONVERSATION_SOFT.has(reason)
}
