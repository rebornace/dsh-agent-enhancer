import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CheckpointRollbackOperation } from '../../host/checkpoint/service.ts'
import { useEffect, useSyncExternalStore } from 'react'
import styles from '../styles.module.css'
import type { RollbackController } from './controller.ts'
import { rollbackModalCopy, RollbackPreview } from './preview.tsx'

export interface RollbackMessageActionsProps {
  readonly rollback: RollbackController
  readonly t: TranslateNS<'composer-enhancer'>
  readonly turn: TurnLocation
  readonly operation: CheckpointRollbackOperation
  readonly inputActions: InputActions
  readonly useSession: (selector: (state: { running: boolean }) => unknown) => unknown
  readonly useAccess: (action: string) => boolean | undefined
}

export function RollbackMessageActions(props: RollbackMessageActionsProps) {
  const snapshot = useSyncExternalStore(props.rollback.subscribe, props.rollback.getSnapshot)
  const session = props.useSession(state => state) as { running: boolean }
  const turn = props.turn
  const active = snapshot.active?.turn === turn.turn && snapshot.active.operation === props.operation
    ? snapshot.active : null
  useEffect(() => () => {
    if (props.rollback.getSnapshot().active?.status !== 'executing') props.rollback.close(turn.turn)
  }, [props.rollback, turn.turn])

  if (!snapshot.enabled) return null

  const entryKey = props.operation === 'undo' ? 'rollbackUndoAction' as const : 'rollbackAction' as const
  const canExecute = props.useAccess('checkpointRollback/execute')
  const disabledReason = canExecute === false ? 'rollbackUnavailablePermission' as const
    : session.running ? 'rollbackUnavailableRunning' as const
      : props.operation === 'rollback' && turn.status !== 'closed' ? 'rollbackTurnOpen' as const
      : props.operation === 'rollback' && turn.start === undefined ? 'rollbackTurnStartMissing' as const
        : props.operation === 'rollback' && turn.start !== undefined && turn.start.seq <= 0
          ? 'rollbackUnavailableFirstTurn' as const : null
  const blocked = active?.preview === undefined || active.preview.unavailable.length > 0 || active.preview.conflicts.length > 0
  const modal = active === null ? null : rollbackModalCopy(props.operation, props.t, turn.turn)

  return <>
    <Button type="button" size="sm" variant="ghost" className={styles.rollbackEntry}
      disabled={disabledReason !== null} title={disabledReason === null ? undefined : props.t(disabledReason)}
      onClick={() => {
        if (disabledReason === null) props.rollback.open(turn.turn, props.operation)
      }}>{props.t(entryKey)}</Button>
    {active === null || modal === null ? null : <Modal
      open
      title={modal.title}
      description={modal.description}
      closeLabel={props.t('rollbackClose')}
      className={styles.rollbackDialog}
      contentClassName={styles.rollbackContent}
      onClose={() => { props.rollback.close(turn.turn) }}
      footer={<>
        <Button type="button" data-modal-autofocus
          onClick={() => { props.rollback.close(turn.turn) }}>{props.t('rollbackCancel')}</Button>
        <Button type="button" disabled={active.status !== 'ready' || blocked}
          onClick={() => { void props.rollback.confirm(props.inputActions) }}>
          {active.status === 'executing' ? modal.executing : modal.confirm}
        </Button>
      </>}
    ><RollbackPreview active={active} t={props.t} /></Modal>}
  </>
}
