export const PREVIEW_TEXT_MAX = 140

/** Collapse whitespace and truncate for scannable restore previews. */
export function truncatePreviewText(text: string, max = PREVIEW_TEXT_MAX): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export type PreviewMessageRole = 'user' | 'assistant' | 'tool' | 'system' | 'other'

export function previewMessageRole(type: string): PreviewMessageRole {
  if (type.startsWith('user/')) return 'user'
  if (type.startsWith('assistant/')) return 'assistant'
  if (type.startsWith('tool/')) return 'tool'
  if (type.startsWith('system/') || type.startsWith('developer/')) return 'system'
  return 'other'
}

export type CoverageAffordance = 'files' | 'partial' | 'conversation' | 'unknown'

/** Classify a stored turn summary for restore-button tooltips. */
export function coverageAffordance(summary: {
  readonly coverage: 'complete' | 'partial'
  readonly fileCount: number
} | undefined): CoverageAffordance {
  if (summary === undefined) return 'unknown'
  if (summary.fileCount > 0) {
    return summary.coverage === 'partial' ? 'partial' : 'files'
  }
  return summary.coverage === 'partial' ? 'partial' : 'conversation'
}

/**
 * Exactly one primary action per checkpoint card / message affordance.
 * Only the live tip undoes (brings back everything that tip withdrew).
 * A later rolled-back card restores *to that turn* (moves the tip forward) so
 * undoing from turn 2 never also resurrects turn 3.
 */
export type CheckpointPrimaryAction = 'restore' | 'undo'

export function checkpointPrimaryAction(summary: {
  readonly tip?: boolean
  readonly rolledBack?: boolean
} | undefined): CheckpointPrimaryAction {
  if (summary?.tip === true) return 'undo'
  return 'restore'
}
