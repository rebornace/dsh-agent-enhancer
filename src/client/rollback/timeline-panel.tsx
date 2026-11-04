import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CheckpointTurnSummary, LiveActivityStats } from '../../host/checkpoint/service.ts'
import styles from '../styles.module.css'
import type { RollbackController } from './controller.ts'
import { checkpointPrimaryAction, coverageAffordance } from './format.ts'
import type { RollbackRemote } from './types.ts'
import {
  formatCheckpointTime,
  sortTimelineByConversation,
  timelineCoverageLabel,
  timelineGapLabel,
  timelinePromptLabel,
} from './timeline-format.ts'

export interface CheckpointTimelinePanelProps {
  readonly sessionId: SessionId
  readonly focusTurn?: number
  readonly remote: RollbackRemote
  readonly t: TranslateNS<'agent-enhancer'>
  readonly locale?: string
  readonly rollback?: RollbackController
  /**
   * Live chat-surface turns/steps (same fold as ActivityPill). When provided,
   * the lead line uses these so the timeline never drifts from visible chat.
   */
  readonly readChatActivity?: () => { readonly turns: number, readonly steps: number } | undefined
  readonly subscribeChatActivity?: (listener: () => void) => () => void
  readonly onRestore: (turn: number) => void
  readonly onUndo: (turn: number) => void
}

type LoadState =
  | { readonly status: 'loading' }
  | {
    readonly status: 'ready'
    readonly turns: readonly CheckpointTurnSummary[]
    readonly activity: LiveActivityStats
  }
  | { readonly status: 'error' }

const emptyActivity: LiveActivityStats = {
  turns: 0,
  steps: 0,
  checkpoints: 0,
  liveCheckpoints: 0,
}

function mergeChatActivity(
  activity: LiveActivityStats,
  chat: { readonly turns: number, readonly steps: number } | undefined,
): LiveActivityStats {
  if (chat === undefined) return activity
  if (activity.turns === chat.turns && activity.steps === chat.steps) return activity
  return { ...activity, turns: chat.turns, steps: chat.steps }
}

export function CheckpointTimelinePanel(props: CheckpointTimelinePanelProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [expanded, setExpanded] = useState<number | null>(props.focusTurn ?? null)
  const [openingTurn, setOpeningTurn] = useState<number | null>(null)
  const [chatActivity, setChatActivity] = useState<
    { readonly turns: number, readonly steps: number } | undefined
  >(() => props.readChatActivity?.())
  const wasActive = useRef(false)

  const reload = useCallback(() => {
    const summaries = props.remote.summaries
    if (summaries === undefined) {
      setState({ status: 'error' })
      return () => {}
    }
    const controller = new AbortController()
    setState({ status: 'loading' })
    void summaries({ sessionId: props.sessionId }, controller.signal).then(result => {
      if (controller.signal.aborted) return
      if (result.sessionId !== props.sessionId) {
        setState({ status: 'error' })
        return
      }
      const turns = sortTimelineByConversation(result.turns)
      const activity = result.activity ?? {
        ...emptyActivity,
        checkpoints: turns.length,
        liveCheckpoints: turns.filter(turn => !turn.rolledBack).length,
      }
      setState({
        status: 'ready',
        turns,
        activity: mergeChatActivity(activity, props.readChatActivity?.()),
      })
      if (props.focusTurn !== undefined && turns.some(turn => turn.turn === props.focusTurn)) {
        setExpanded(props.focusTurn)
      }
    }).catch(() => {
      if (!controller.signal.aborted) setState({ status: 'error' })
    })
    return () => { controller.abort() }
  }, [props.focusTurn, props.readChatActivity, props.remote, props.sessionId])

  useEffect(() => reload(), [reload]) // reload() returns the abort disposer

  // Keep lead-line 轮/步 locked to the presented chat surface (same as ActivityPill).
  useEffect(() => {
    const read = props.readChatActivity
    if (read === undefined) return
    const sync = () => {
      let next: { readonly turns: number, readonly steps: number } | undefined
      try {
        next = read()
      } catch {
        return
      }
      setChatActivity(previous => {
        if (previous?.turns === next?.turns && previous?.steps === next?.steps) return previous
        return next
      })
    }
    sync()
    try {
      return props.subscribeChatActivity?.(sync)
    } catch {
      return undefined
    }
  }, [props.readChatActivity, props.subscribeChatActivity])

  useEffect(() => {
    if (chatActivity === undefined) return
    setState(previous => {
      if (previous.status !== 'ready') return previous
      const activity = mergeChatActivity(previous.activity, chatActivity)
      if (activity === previous.activity) return previous
      return { ...previous, activity }
    })
  }, [chatActivity])

  // After restore/undo finishes, badges and tip must refresh from the host.
  useEffect(() => {
    if (props.rollback === undefined) return
    return props.rollback.subscribe(() => {
      const active = props.rollback!.getSnapshot().active
      if (active !== null) {
        wasActive.current = true
        if (active.status === 'loading' || active.status === 'ready' || active.status === 'executing') {
          setOpeningTurn(active.turn)
        }
        return
      }
      setOpeningTurn(null)
      if (wasActive.current) {
        wasActive.current = false
        reload()
      }
    })
  }, [props.rollback, reload])

  if (state.status === 'loading') {
    return <p className={styles.timelineStatus} role="status">{props.t('rollbackTimelineLoading')}</p>
  }
  if (state.status === 'error') {
    return <div className={styles.timelineStatus}>
      <p role="alert">{props.t('rollbackTimelineFailed')}</p>
      <Button type="button" onClick={() => { reload() }}>{props.t('rollbackRetry')}</Button>
    </div>
  }
  if (state.turns.length === 0) {
    return <p className={styles.timelineStatus}>{props.t('rollbackTimelineEmpty')}</p>
  }

  const { activity } = state

  return <div className={styles.timelinePanel}>
    <p className={styles.timelineLead}>
      {props.t('rollbackTimelineLead', {
        turns: activity.turns,
        steps: activity.steps,
        checkpoints: activity.checkpoints,
        liveCheckpoints: activity.liveCheckpoints,
      })}
    </p>
    <ol className={styles.timelineList}>
      {state.turns.map(summary => {
        const open = expanded === summary.turn
        const time = formatCheckpointTime(summary.createdAt, props.locale ?? 'en')
        const coverage = coverageAffordance(summary)
        const prompt = timelinePromptLabel(summary, props.t)
        const opening = openingTurn === summary.turn
        const covered = summary.rolledBack && !summary.tip
        const primary = checkpointPrimaryAction(summary)
        return <li
          key={summary.turn}
          className={styles.timelineItem}
          data-coverage={coverage}
          data-expanded={open || undefined}
          data-rolled-back={summary.rolledBack || undefined}
          data-tip={summary.tip || undefined}
          data-action={primary}
        >
          <button
            type="button"
            className={styles.timelineRow}
            aria-expanded={open}
            onClick={() => { setExpanded(open ? null : summary.turn) }}
          >
            <span className={styles.timelineHead}>
              <span className={styles.timelineTurn}>{props.t('rollbackTimelineTurn', { turn: summary.turn })}</span>
              {summary.tip
                ? <span className={styles.timelineRolledBack}>{props.t('rollbackTimelineTip')}</span>
                : summary.rolledBack
                  ? <span className={styles.timelineRolledBack}>{props.t('rollbackTimelineRolledBack')}</span>
                  : null}
              <span className={styles.timelineCoverage} data-coverage={coverage}>
                {timelineCoverageLabel(summary, props.t)}
              </span>
              <span className={styles.timelineTime}>{time}</span>
            </span>
            <span
              className={prompt.empty ? styles.timelinePromptEmpty : styles.timelinePromptPreview}
            >
              {prompt.text}
            </span>
          </button>
          {!open ? null : <div className={styles.timelineDetail}>
            {summary.promptPreview.length === 0
              ? <p className={styles.timelinePromptEmpty}>{props.t('rollbackTimelineNoPrompt')}</p>
              : <p className={styles.timelinePrompt}>{summary.promptPreview}</p>}
            {summary.files.length === 0
              ? <p className={styles.timelineFilesEmpty}>{props.t('rollbackNoFiles')}</p>
              : <ul className={styles.timelineFiles}>
                {summary.files.map(file => <li key={file.path} data-change={file.change}>
                  <span>{file.path}</span>
                  <span className={styles.timelineFileChange} data-change={file.change}>
                    {props.t(`rollbackFile_${file.change}`)}
                  </span>
                </li>)}
              </ul>}
            {summary.gaps.length === 0 ? null : <ul className={styles.timelineGaps}>
              {summary.gaps.map(gap => <li key={`${gap.type}:${gap.reason}`} data-gap={gap.type}>
                {timelineGapLabel(gap, props.t)}
              </li>)}
            </ul>}
            {covered
              ? <p className={styles.timelineFilesEmpty} role="status">
                {props.t('rollbackTimelineCoveredHint')}
              </p>
              : null}
            {opening
              ? <p className={styles.timelineFilesEmpty} role="status">
                {props.t('rollbackTimelineOpening')}
              </p>
              : null}
            {primary === 'undo' ? <Button
              type="button"
              disabled={opening}
              onClick={() => {
                setOpeningTurn(summary.turn)
                props.onUndo(summary.turn)
              }}
            >
              {props.t('rollbackUndoAction')}
            </Button> : <Button type="button" disabled={opening} onClick={() => {
              setOpeningTurn(summary.turn)
              props.onRestore(summary.turn)
            }}>
              {props.t('rollbackAction')}
            </Button>}
          </div>}
        </li>
      })}
    </ol>
  </div>
}
