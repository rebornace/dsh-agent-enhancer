import type { TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore } from 'react'
import { UndoIcon } from '../dsh/icons.tsx'
import styles from '../styles.module.css'
import type { RollbackController } from './controller.ts'

export interface RollbackMessageActionsProps {
  readonly rollback: RollbackController
  readonly t: TranslateNS<'composer-enhancer'>
  readonly turn: TurnLocation
  readonly useSession: (selector: (state: { running: boolean }) => unknown) => unknown
  readonly useAccess: (action: string) => boolean | undefined
}

/** Icon entry for the common “Restore to here” action beside Copy. */
export function RollbackMessageActions(props: RollbackMessageActionsProps) {
  const snapshot = useSyncExternalStore(props.rollback.subscribe, props.rollback.getSnapshot)
  const session = props.useSession(state => state) as { running: boolean }
  const turn = props.turn

  if (!snapshot.enabled) return null

  const canExecute = props.useAccess('checkpointRollback/execute')
  // turn.start.seq === 0 only means the turn begins at the log head; restore before
  // it is still valid when a system prompt occupies seq 0 and the cut is atSeq 0.
  const disabledReason = canExecute === false ? 'rollbackUnavailablePermission' as const
    : session.running ? 'rollbackUnavailableRunning' as const
      : turn.status !== 'closed' ? 'rollbackTurnOpen' as const
        : turn.start === undefined ? 'rollbackTurnStartMissing' as const
          : null

  const entryLabel = props.t('rollbackAction')
  const entryTooltip = disabledReason === null ? entryLabel : props.t(disabledReason)

  return <Tooltip label={entryTooltip} side="bottom">
    <button
      type="button"
      className={styles.userMessageAction}
      aria-label={entryLabel}
      title={entryTooltip}
      disabled={disabledReason !== null}
      data-unavailable={disabledReason !== null || undefined}
      onClick={() => {
        if (disabledReason === null) props.rollback.open(turn.turn, 'rollback')
      }}
    >
      <UndoIcon />
    </button>
  </Tooltip>
}
