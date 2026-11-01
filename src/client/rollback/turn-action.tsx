import { Button, MenuSurface, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useSyncExternalStore } from 'react'
import type { CheckpointUnavailable } from '../../host/checkpoint/service.ts'
import type { FileConflict } from '../../host/checkpoint/files.ts'
import styles from '../styles.module.css'
import type { RollbackController } from './controller.ts'
import type { RollbackActive } from './types.ts'

export type RollbackTurnActionProps = PropsRuntime<'conversation.chat.turnTail'> & {
  readonly rollback: RollbackController
  readonly t: TranslateNS<'composer-enhancer'>
}

const UNAVAILABLE_KEYS: Record<CheckpointUnavailable, Parameters<RollbackTurnActionProps['t']>[0]> = {
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

const CONFLICT_KEYS: Record<FileConflict['reason'], Parameters<RollbackTurnActionProps['t']>[0]> = {
  'unsafe-path': 'rollbackConflictUnsafe',
  'symlink': 'rollbackConflictSymlink',
  'not-regular-file': 'rollbackConflictRegular',
  'binary': 'rollbackConflictBinary',
  'too-large': 'rollbackConflictLarge',
  'invalid-before-image': 'rollbackConflictBefore',
  'hash-mismatch': 'rollbackConflictHash',
}

function Preview({ active, t }: {
  readonly active: RollbackActive
  readonly t: RollbackTurnActionProps['t']
}) {
  if (active.status === 'loading' || active.status === 'executing') {
    return <p role="status">{t(active.status === 'loading' ? 'rollbackLoading' : 'rollbackRestoring')}</p>
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

export function RollbackTurnAction(props: RollbackTurnActionProps) {
  const snapshot = useSyncExternalStore(props.rollback.subscribe, props.rollback.getSnapshot)
  const session = props.useSession(state => state)
  const turn = props.turn
  const active = snapshot.active?.turn === turn.turn ? snapshot.active : null
  useEffect(() => () => {
    if (props.rollback.getSnapshot().active?.status !== 'executing') props.rollback.close(turn.turn)
  }, [props.rollback, turn.turn])

  if (!snapshot.enabled) return null
  const disabledReason = session.running ? 'rollbackUnavailableRunning' as const
    : turn.status !== 'closed' ? 'rollbackTurnOpen' as const
      : turn.start === undefined ? 'rollbackTurnStartMissing' as const
        : turn.start.seq <= 0 ? 'rollbackUnavailableFirstTurn' as const : null
  const blocked = active?.preview === undefined || active.preview.unavailable.length > 0 || active.preview.conflicts.length > 0
  return <>
    <Button type="button" size="sm" variant="ghost" className={styles.rollbackEntry}
      disabled={disabledReason !== null} title={disabledReason === null ? undefined : props.t(disabledReason)}
      onClick={() => {
        if (disabledReason === null) props.rollback.open(turn.turn)
      }}>{props.t('rollbackAction')}</Button>
    {active === null ? null : <Modal
      open
      title={props.t('rollbackTitle', { turn: turn.turn })}
      description={props.t('rollbackScope')}
      closeLabel={props.t('rollbackClose')}
      className={styles.rollbackDialog}
      contentClassName={styles.rollbackContent}
      onClose={() => { props.rollback.close(turn.turn) }}
      footer={<>
        <Button type="button" data-modal-autofocus
          onClick={() => { props.rollback.close(turn.turn) }}>{props.t('rollbackCancel')}</Button>
        <Button type="button" disabled={active.status !== 'ready' || blocked}
          onClick={() => { void props.rollback.confirm(props.inputActions) }}>
          {props.t(active.status === 'executing' ? 'rollbackRestoring' : 'rollbackConfirm')}
        </Button>
      </>}
    ><Preview active={active} t={props.t} /></Modal>}
  </>
}
