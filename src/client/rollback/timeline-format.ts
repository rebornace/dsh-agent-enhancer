import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CheckpointGap } from '../../host/checkpoint/types.ts'
import type { CheckpointTurnSummary } from '../../host/checkpoint/service.ts'
import { coverageAffordance } from './format.ts'

export function timelineCoverageLabel(
  summary: CheckpointTurnSummary,
  t: TranslateNS<'agent-enhancer'>,
): string {
  const affordance = coverageAffordance(summary)
  switch (affordance) {
    case 'files':
      return t('rollbackTimelineCoverageFiles', { count: summary.fileCount })
    case 'partial':
      return t('rollbackTimelineCoveragePartial', { count: summary.fileCount })
    case 'conversation':
      return t('rollbackTimelineCoverageConversation')
    case 'unknown':
      return t('rollbackTimelineCoverageUnknown')
    default: {
      const _exhaustive: never = affordance
      return _exhaustive
    }
  }
}

export function timelineGapLabel(
  gap: CheckpointGap,
  t: TranslateNS<'agent-enhancer'>,
): string {
  switch (gap.type) {
    case 'prompt':
      return t('rollbackGapPrompt')
    case 'workspace':
      return t('rollbackGapWorkspace')
    default: {
      const _exhaustive: never = gap
      return _exhaustive
    }
  }
}

/**
 * Conversation order for the timeline rail (oldest → newest by log position).
 * Sorting by turn id alone inverts after undo shells / reused turn numbers and
 * makes “第 3 个检查点” look later while restoring an earlier cut.
 */
export function sortTimelineByConversation(
  turns: readonly CheckpointTurnSummary[],
): CheckpointTurnSummary[] {
  return [...turns].sort((left, right) => (
    left.atSeq - right.atSeq || left.turn - right.turn || left.createdAt - right.createdAt
  ))
}

/** @deprecated Use {@link sortTimelineByConversation}. */
export function sortTimelineNewestFirst(
  turns: readonly CheckpointTurnSummary[],
): CheckpointTurnSummary[] {
  return sortTimelineByConversation(turns)
}

export function formatCheckpointTime(createdAt: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(createdAt))
  } catch {
    return new Date(createdAt).toLocaleString()
  }
}

/**
 * Collapsed-row label: prefer prompt preview; fall back to a file path so empty
 * historical captures are still distinguishable without memorizing turn numbers.
 */
export function timelinePromptLabel(
  summary: CheckpointTurnSummary,
  t: TranslateNS<'agent-enhancer'>,
): { readonly text: string, readonly empty: boolean } {
  if (summary.promptPreview.length > 0) {
    return { text: summary.promptPreview, empty: false }
  }
  const first = summary.files[0]
  if (first !== undefined) {
    return {
      text: summary.files.length === 1
        ? t('rollbackTimelineFileFallback', { path: first.path })
        : t('rollbackTimelineFilesFallback', { path: first.path, count: summary.files.length }),
      empty: false,
    }
  }
  return { text: t('rollbackTimelineNoPrompt'), empty: true }
}
