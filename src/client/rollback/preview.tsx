import { MenuSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { blockingUnavailable } from '../../host/checkpoint/availability.ts'
import type { CheckpointRollbackScope, CheckpointUnavailable } from '../../host/checkpoint/availability.ts'
import type { FileConflict } from '../../host/checkpoint/files.ts'
import styles from '../styles.module.css'
import type { RollbackActive } from './types.ts'

const UNAVAILABLE_KEYS: Record<CheckpointUnavailable, Parameters<TranslateNS<'composer-enhancer'>>[0]> = {
  'checkpoint-not-found': 'rollbackUnavailableCheckpoint',
  'incomplete-checkpoint': 'rollbackUnavailableIncomplete',
  'prompt-non-text-content': 'rollbackGapPrompt',
  'workspace-capture-failed': 'rollbackGapWorkspace',
  'session-changed': 'rollbackUnavailableSessionChanged',
  'session-running': 'rollbackUnavailableRunning',
  'permission-denied': 'rollbackUnavailablePermission',
  'rollback-disabled': 'rollbackUnavailableDisabled',
  'first-turn': 'rollbackUnavailableFirstTurn',
  'incompatible-session': 'rollbackUnavailableIncompatible',
  'compacted-surface': 'rollbackUnavailableCompacted',
  'subagent-session': 'rollbackUnavailableSubagent',
  'unknown-surface': 'rollbackUnavailableUnknown',
}

const CONFLICT_KEYS: Record<FileConflict['reason'], Parameters<TranslateNS<'composer-enhancer'>>[0]> = {
  'unsafe-path': 'rollbackConflictUnsafe',
  'symlink': 'rollbackConflictSymlink',
  'not-regular-file': 'rollbackConflictRegular',
  'binary': 'rollbackConflictBinary',
  'too-large': 'rollbackConflictLarge',
  'invalid-before-image': 'rollbackConflictBefore',
  'invalid-after-image': 'rollbackConflictBefore',
  'hash-mismatch': 'rollbackConflictHash',
}

export function RollbackPreview({ active, t }: {
  readonly active: RollbackActive
  readonly t: TranslateNS<'composer-enhancer'>
}) {
  if (active.status === 'loading' || active.status === 'executing') {
    const loadingKey = active.status === 'loading'
      ? 'rollbackLoading'
      : active.operation === 'undo' ? 'rollbackUndoRestoring' : 'rollbackRestoring'
    return <p role="status">{t(loadingKey)}</p>
  }
  if (active.status === 'error') return <p role="alert">{t('rollbackFailed')}</p>
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
  return <MenuSurface className={styles.rollbackPreview}>
    <section className={styles.rollbackSection} aria-label={t('rollbackMessages')}>
      <h3>{t('rollbackMessages')}</h3>
      {preview.messages.length === 0 ? <p>{t('rollbackNoMessages')}</p> : <ul className={styles.rollbackList}>
        {preview.messages.map(message => <li key={message.seq} className={styles.rollbackMessage}>
          <span className={styles.rollbackMeta}>{message.type} · {message.seq}</span>
          <span>{message.text}</span>
        </li>)}
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
        <span>{conflict.path}</span><span className={styles.rollbackConflict}>{t(CONFLICT_KEYS[conflict.reason])}</span>
      </li>)}</ul>
    </section>}
  </MenuSurface>
}

export function rollbackModalCopy(
  operation: RollbackActive['operation'],
  t: TranslateNS<'composer-enhancer'>,
  turn: number,
  scope?: CheckpointRollbackScope,
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
  return {
    title: t('rollbackTitle', { turn }),
    description: t('rollbackScope'),
    confirm: t('rollbackConfirm'),
    confirmConversation: t('rollbackConfirmConversation'),
    executing: t('rollbackRestoring'),
    executingConversation: t('rollbackRestoringConversation'),
  }
}
