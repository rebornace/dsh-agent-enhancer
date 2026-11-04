import { MenuSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { blockingUnavailable } from '../../host/checkpoint/availability.ts'
import type { CheckpointRollbackScope, CheckpointUnavailable } from '../../host/checkpoint/availability.ts'
import type { FileConflict } from '../../host/checkpoint/files.ts'
import styles from '../styles.module.css'
import { rollbackFailureMessageKey } from './failure.ts'
import {
  previewMessageRole,
  truncatePreviewText,
  type PreviewMessageRole,
} from './format.ts'
import type { RollbackActive } from './types.ts'

const UNAVAILABLE_KEYS: Record<CheckpointUnavailable, Parameters<TranslateNS<'agent-enhancer'>>[0]> = {
  'checkpoint-not-found': 'rollbackUnavailableCheckpoint',
  'incomplete-checkpoint': 'rollbackUnavailableIncomplete',
  'prompt-non-text-content': 'rollbackGapPrompt',
  'workspace-capture-failed': 'rollbackGapWorkspace',
  'session-changed': 'rollbackUnavailableSessionChanged',
  'session-running': 'rollbackUnavailableRunning',
  'permission-denied': 'rollbackUnavailablePermission',
  'rollback-disabled': 'rollbackUnavailableDisabled',
  'incompatible-session': 'rollbackUnavailableIncompatible',
  'compacted-surface': 'rollbackUnavailableCompacted',
  'subagent-session': 'rollbackUnavailableSubagent',
  'unknown-surface': 'rollbackUnavailableUnknown',
  'already-restored': 'rollbackUnavailableAlready',
  'covered-by-earlier-restore': 'rollbackUnavailableCovered',
}

const CONFLICT_KEYS: Record<FileConflict['reason'], Parameters<TranslateNS<'agent-enhancer'>>[0]> = {
  'unsafe-path': 'rollbackConflictUnsafe',
  'symlink': 'rollbackConflictSymlink',
  'not-regular-file': 'rollbackConflictRegular',
  'binary': 'rollbackConflictBinary',
  'too-large': 'rollbackConflictLarge',
  'invalid-before-image': 'rollbackConflictBefore',
  'invalid-after-image': 'rollbackConflictBefore',
  'hash-mismatch': 'rollbackConflictHash',
}

const ROLE_KEYS: Record<PreviewMessageRole, Parameters<TranslateNS<'agent-enhancer'>>[0]> = {
  user: 'rollbackRole_user',
  assistant: 'rollbackRole_assistant',
  tool: 'rollbackRole_tool',
  system: 'rollbackRole_system',
  other: 'rollbackRole_other',
}

export function RollbackPreview({ active, t, onOpenTimeline }: {
  readonly active: RollbackActive
  readonly t: TranslateNS<'agent-enhancer'>
  readonly onOpenTimeline?: (turn: number) => void
}) {
  if (active.status === 'loading' || active.status === 'executing') {
    const loadingKey = active.status === 'loading'
      ? 'rollbackLoading'
      : active.operation === 'undo' ? 'rollbackUndoRestoring' : 'rollbackRestoring'
    return <p role="status">{t(loadingKey)}</p>
  }
  if (active.status === 'error') {
    return <p role="alert">{t(rollbackFailureMessageKey(active.errorCode))}</p>
  }
  const preview = active.preview
  if (preview === undefined) return null
  // Soft capture gaps do not block conversation-only restore — never list them under
  // a fatal "unavailable" heading or users conclude rollback is impossible.
  const hardUnavailable = blockingUnavailable(preview.unavailable, 'conversation', {
    trackedFiles: preview.files.length,
  })
  const filesLimited = active.operation !== 'undo'
    && blockingUnavailable(preview.unavailable, 'conversation-and-files', {
      trackedFiles: preview.files.length,
    }).length > hardUnavailable.length
  const alreadyRestored = active.operation !== 'undo'
    && preview.unavailable.includes('already-restored')
  const coveredByEarlier = active.operation !== 'undo'
    && preview.unavailable.includes('covered-by-earlier-restore')
  const tipTurn = preview.tipTurn
  return <MenuSurface className={styles.rollbackPreview}>
    <div className={styles.rollbackSummaryRow}>
      <p className={styles.rollbackSummary} aria-label={t('rollbackSummaryLabel')}>
        {t('rollbackSummary', { messages: preview.messages.length, files: preview.files.length })}
      </p>
      {onOpenTimeline === undefined || active.operation === 'undo' ? null
        : <button
          type="button"
          className={styles.rollbackTimelineLink}
          onClick={() => { onOpenTimeline(active.turn) }}
        >
          {t('rollbackTimelineOpen')}
        </button>}
    </div>
    {alreadyRestored
      ? <p className={styles.rollbackAlready} role="status">{t('rollbackAlreadyRestored')}</p>
      : null}
    {coveredByEarlier
      ? <p className={styles.rollbackAlready} role="status">
        {t('rollbackCoveredByEarlier', { tipTurn: tipTurn ?? active.turn })}
      </p>
      : null}
    <section className={styles.rollbackSection} aria-label={t('rollbackMessages')}>
      <h3>{t('rollbackMessages')}</h3>
      {preview.messages.length === 0 ? <p>{t('rollbackNoMessages')}</p> : <ul className={styles.rollbackList}>
        {preview.messages.map(message => {
          const role = previewMessageRole(message.type)
          const text = truncatePreviewText(message.text)
          return <li key={message.seq} className={styles.rollbackMessage}>
            <span className={styles.rollbackMeta}>{t(ROLE_KEYS[role])}</span>
            <span>{text.length === 0 ? t('rollbackMessageEmpty') : text}</span>
          </li>
        })}
      </ul>}
    </section>
    <section className={styles.rollbackSection} aria-label={t('rollbackFiles')}>
      <h3>{t('rollbackFiles')}</h3>
      {preview.files.length === 0 ? <p>{t('rollbackNoFiles')}</p> : <ul className={styles.rollbackList}>
        {preview.files.map(file => <li key={file.path} className={styles.rollbackFile}>
          <span>{file.path}</span><span className={styles.rollbackMeta}>{t(`rollbackFile_${file.change}`)}</span>
        </li>)}
      </ul>}
    </section>
    {hardUnavailable.length === 0 ? null : <section className={styles.rollbackSection} aria-label={t('rollbackGaps')}>
      <h3>{t('rollbackGaps')}</h3>
      <ul className={styles.rollbackList}>{hardUnavailable.map(reason => <li key={reason}>
        {t(UNAVAILABLE_KEYS[reason])}
      </li>)}</ul>
    </section>}
    {!filesLimited ? null : <section className={styles.rollbackSection} aria-label={t('rollbackFilesLimited')}>
      <h3>{t('rollbackFilesLimited')}</h3>
      <p>{t('rollbackFilesLimitedHint')}</p>
    </section>}
    {preview.conflicts.length === 0 ? null : <section className={styles.rollbackSection} aria-label={t('rollbackConflicts')}>
      <h3>{t('rollbackConflicts')}</h3>
      <ul className={styles.rollbackList}>{preview.conflicts.map(conflict => <li key={`${conflict.path}:${conflict.reason}`}>
        <span>{conflict.path}</span>
        <span className={styles.rollbackConflict}>
          {t(CONFLICT_KEYS[conflict.reason])}
          {conflict.reason === 'hash-mismatch' ? ` · ${t('rollbackConflictHashHint')}` : null}
        </span>
      </li>)}</ul>
    </section>}
  </MenuSurface>
}

export function rollbackModalCopy(
  operation: RollbackActive['operation'],
  t: TranslateNS<'agent-enhancer'>,
  turn: number,
  scope?: CheckpointRollbackScope,
  alreadyRestored = false,
  coveredByEarlier = false,
): {
  readonly title: string
  readonly description: string
  readonly confirm: string
  readonly confirmConversation: string
  readonly executing: string
  readonly executingConversation: string
} {
  if (operation === 'undo') {
    const conversationOnly = scope === 'conversation'
    return {
      title: t('rollbackUndoTitle', { turn }),
      description: t(conversationOnly ? 'rollbackUndoScopeConversation' : 'rollbackUndoScope'),
      confirm: t(conversationOnly ? 'rollbackUndoConfirmConversation' : 'rollbackUndoConfirm'),
      confirmConversation: t('rollbackUndoConfirmConversation'),
      executing: t(conversationOnly ? 'rollbackUndoRestoringConversation' : 'rollbackUndoRestoring'),
      executingConversation: t('rollbackUndoRestoringConversation'),
    }
  }
  if (coveredByEarlier) {
    return {
      title: t('rollbackTitle', { turn }),
      description: t('rollbackScopeCovered'),
      confirm: t('rollbackConfirm'),
      confirmConversation: t('rollbackConfirmConversation'),
      executing: t('rollbackRestoring'),
      executingConversation: t('rollbackRestoringConversation'),
    }
  }
  return {
    title: t('rollbackTitle', { turn }),
    description: t(alreadyRestored ? 'rollbackScopeAlready' : 'rollbackScope'),
    confirm: t(alreadyRestored ? 'rollbackConfirmAlready' : 'rollbackConfirm'),
    confirmConversation: t(alreadyRestored ? 'rollbackConfirmConversationAlready' : 'rollbackConfirmConversation'),
    executing: t('rollbackRestoring'),
    executingConversation: t('rollbackRestoringConversation'),
  }
}
