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
  | 'incompatible-session'
  | 'compacted-surface'
  | 'subagent-session'
  | 'unknown-surface'
  /** Tip already sits at this cut — confirm prefills draft / may re-apply files. */
  | 'already-restored'
  /**
   * A more aggressive tip already hides this cut. Restore here is a no-op until
   * the live tip is undone.
   */
  | 'covered-by-earlier-restore'

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
  // Non-contiguous logs are unusual but still restorable when a surface was built.
  // Only emit unknown-surface when surface is missing — that case stays hard.
  // Re-confirming the active tip is a soft no-op (draft prefill / optional files).
  'already-restored',
  // Covered cuts need undo-first — UI replaces confirms with Undo, not a fatal gap list.
  'covered-by-earlier-restore',
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
  'already-restored',
  'covered-by-earlier-restore',
])

/**
 * Soft gaps that must not block restoring already-tracked file paths. Workspace
 * capture may be partial (shell side effects) while write/edit/shell snapshots
 * are still known and restorable. Prompt gaps only affect draft text, not files.
 */
const TRACKED_FILES_SOFT = new Set<CheckpointUnavailable>([
  'incomplete-checkpoint',
  'workspace-capture-failed',
  'prompt-non-text-content',
  'already-restored',
  'covered-by-earlier-restore',
])

export interface BlockingUnavailableOptions {
  readonly trackedFiles?: number
}

export function blockingUnavailable(
  unavailable: readonly CheckpointUnavailable[],
  scope: CheckpointRollbackScope,
  options: BlockingUnavailableOptions = {},
): readonly CheckpointUnavailable[] {
  const trackedFiles = options.trackedFiles ?? 0
  const soft = scope === 'conversation'
    ? CONVERSATION_SOFT
    : trackedFiles === 0
      ? EMPTY_FILES_SOFT
      : TRACKED_FILES_SOFT
  return unavailable.filter(reason => !soft.has(reason))
}

/** Reasons that never block conversation-only restore (UI should not call them fatal). */
export function isConversationSoftUnavailable(reason: CheckpointUnavailable): boolean {
  return CONVERSATION_SOFT.has(reason)
}
