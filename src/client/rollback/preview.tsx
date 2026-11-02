import { MenuSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CheckpointUnavailable } from '../../host/checkpoint/service.ts'
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
    {preview.unavailable.length === 0 ? null : <section className={styles.rollbackSection} aria-label={t('rollbackGaps')}>
      <h3>{t('rollbackGaps')}</h3>
      <ul className={styles.rollbackList}>{preview.unavailable.map(reason => <li key={reason}>
        {t(UNAVAILABLE_KEYS[reason])}
      </li>)}</ul>
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
): {
  readonly title: string
  readonly description: string
  readonly confirm: string
  readonly executing: string
} {
  if (operation === 'undo') {
    return {
      title: t('rollbackUndoTitle', { turn }),
      description: t('rollbackUndoScope'),
      confirm: t('rollbackUndoConfirm'),
      executing: t('rollbackUndoRestoring'),
    }
  }
  return {
    title: t('rollbackTitle', { turn }),
    description: t('rollbackScope'),
    confirm: t('rollbackConfirm'),
    executing: t('rollbackRestoring'),
  }
}
