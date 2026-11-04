import type { TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore } from 'react'
import { TimelineIcon, UndoIcon } from '../dsh/icons.tsx'
import styles from '../styles.module.css'
import type { RollbackController } from './controller.ts'
import { checkpointPrimaryAction, coverageAffordance } from './format.ts'

export interface RollbackMessageActionsProps {
  readonly rollback: RollbackController
  readonly t: TranslateNS<'agent-enhancer'>
  readonly turn: TurnLocation
  readonly useSession: (selector: (state: { running: boolean }) => unknown) => unknown
  readonly useAccess: (action: string) => boolean | undefined
  readonly onOpenTimeline?: (turn: number) => void
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

  const summary = snapshot.coverageByTurn[turn.turn]
  const affordance = coverageAffordance(summary)
  const primary = checkpointPrimaryAction(summary)
  const entryLabel = primary === 'undo' ? props.t('rollbackUndoAction') : props.t('rollbackAction')
  const coverageLabel = disabledReason !== null || primary === 'undo' ? null
    : affordance === 'files' ? props.t('rollbackCoverageFiles', { count: summary!.fileCount })
      : affordance === 'partial' ? props.t('rollbackCoveragePartial', {
        count: summary!.fileCount,
      })
        : affordance === 'conversation' ? props.t('rollbackCoverageConversation')
          : null
  const entryTooltip = disabledReason !== null ? props.t(disabledReason)
    : coverageLabel ?? entryLabel
  const timelineLabel = props.t('rollbackTimelineOpen')
  const actionDisabled = disabledReason !== null

  return <>
    <Tooltip label={entryTooltip} side="bottom">
      <button
        type="button"
        className={styles.userMessageAction}
        aria-label={entryTooltip}
        title={entryTooltip}
        disabled={actionDisabled}
        data-unavailable={actionDisabled || undefined}
        data-coverage={primary === 'restore' && affordance !== 'unknown' ? affordance : undefined}
        data-action={primary}
        onClick={() => {
          if (actionDisabled) return
          if (primary === 'undo') {
            props.rollback.open(turn.turn, 'undo')
            return
          }
          props.rollback.open(turn.turn, 'rollback')
        }}
      >
        <UndoIcon />
      </button>
    </Tooltip>
    {props.onOpenTimeline === undefined ? null : <Tooltip label={timelineLabel} side="bottom">
      <button
        type="button"
        className={styles.userMessageAction}
        aria-label={timelineLabel}
        title={timelineLabel}
        onClick={() => { props.onOpenTimeline?.(turn.turn) }}
      >
        <TimelineIcon />
      </button>
    </Tooltip>}
  </>
}
