import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CheckpointTurnSummary, LiveActivityStats } from '../../host/checkpoint/service.ts'
import styles from '../styles.module.css'
import type { RollbackController } from './controller.ts'
import { coverageAffordance } from './format.ts'
import type { RollbackRemote } from './types.ts'
import {
  formatCheckpointTime,
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
   * Visible chat-surface turns/steps for the timeline lead only.
   * Official ActivityPill / sessionStats keep the Host whole-log ledger.
   */
  readonly readChatActivity?: () => { readonly turns: number, readonly steps: number } | undefined
  readonly subscribeChatActivity?: (listener: () => void) => () => void
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

function matchesQuery(summary: CheckpointTurnSummary, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (normalized.length === 0) return true
  if (String(summary.turn).includes(normalized)) return true
  if (summary.prompt.toLowerCase().includes(normalized)) return true
  if (summary.promptPreview.toLowerCase().includes(normalized)) return true
  return summary.files.some(file => file.path.toLowerCase().includes(normalized))
}

export function CheckpointTimelinePanel(props: CheckpointTimelinePanelProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [expanded, setExpanded] = useState<number | null>(props.focusTurn ?? null)
  const [query, setQuery] = useState('')
  const [busyTurn, setBusyTurn] = useState<number | null>(null)
  const wasActive = useRef(false)
  const [chatActivity, setChatActivity] = useState(
    () => props.readChatActivity?.() ?? undefined,
  )

  const load = useCallback((options: { quiet?: boolean } = {}) => {
    const summaries = props.remote.summaries
    if (summaries === undefined) {
      setState({ status: 'error' })
      return
    }
    if (!options.quiet) setState({ status: 'loading' })
    const controller = new AbortController()
    void summaries({ sessionId: props.sessionId }, controller.signal).then(result => {
      setState({
        status: 'ready',
        turns: result.turns,
        activity: mergeChatActivity(result.activity, props.readChatActivity?.()),
      })
    }, () => {
      if (!options.quiet) setState({ status: 'error' })
    })
    return () => { controller.abort() }
  }, [props.remote.summaries, props.sessionId, props.readChatActivity])

  useEffect(() => load(), [load])

  useEffect(() => {
    if (props.subscribeChatActivity === undefined) return
    return props.subscribeChatActivity(() => {
      setChatActivity(props.readChatActivity?.())
    })
  }, [props.subscribeChatActivity, props.readChatActivity])

  useEffect(() => {
    setState(previous => {
      if (previous.status !== 'ready') return previous
      const activity = mergeChatActivity(previous.activity, chatActivity)
      if (activity === previous.activity) return previous
      return { ...previous, activity }
    })
  }, [chatActivity])

  useEffect(() => {
    if (props.rollback === undefined) return
    return props.rollback.subscribe(() => {
      const active = props.rollback!.getSnapshot().active
      if (active !== null) {
        wasActive.current = true
        return
      }
      if (wasActive.current) {
        wasActive.current = false
        load({ quiet: true })
      }
    })
  }, [props.rollback, load])

  const visible = useMemo(() => {
    if (state.status !== 'ready') return [] as readonly CheckpointTurnSummary[]
    return state.turns.filter(turn => matchesQuery(turn, query))
  }, [state, query])

  const openRestore = (summary: CheckpointTurnSummary, operation: 'rollback' | 'undo') => {
    if (props.rollback === undefined) return
    setBusyTurn(summary.turn)
    props.rollback.open(summary.turn, operation, { surface: 'timeline', atSeq: summary.atSeq })
    setBusyTurn(null)
  }

  if (state.status === 'loading') {
    return <p className={styles.timelineStatus} role="status">{props.t('rollbackTimelineLoading')}</p>
  }
  if (state.status === 'error') {
    return <div className={styles.timelineStatus}>
      <p role="alert">{props.t('rollbackTimelineFailed')}</p>
      <Button type="button" onClick={() => { load() }}>{props.t('rollbackRetry')}</Button>
    </div>
  }
  if (state.turns.length === 0) {
    return <p className={styles.timelineStatus}>{props.t('rollbackTimelineEmpty')}</p>
  }

  const tipTurn = state.turns.find(turn => turn.tip)?.turn

  return <div className={styles.timelinePanel}>
    {tipTurn === undefined ? null : <header className={styles.timelineToolbar}>
      <p className={styles.timelineLeadNote} role="note">
        {props.t('rollbackTimelineLeadRestoredNote')}
      </p>
    </header>}

    <div className={styles.timelineSearchRow}>
      <Input
        type="search"
        value={query}
        className={styles.timelineSearch}
        placeholder={props.t('rollbackTimelineSearchPlaceholder')}
        aria-label={props.t('rollbackTimelineSearchLabel')}
        onChange={event => { setQuery(event.target.value) }}
      />
    </div>

    {visible.length === 0
      ? <p className={styles.timelineStatus}>{props.t('rollbackTimelineFilterEmpty')}</p>
      : <ol className={styles.timelineList}>
        {visible.map(summary => {
          const open = expanded === summary.turn
          const time = formatCheckpointTime(summary.createdAt, props.locale ?? 'en')
          const coverage = coverageAffordance(summary)
          const prompt = timelinePromptLabel(summary, props.t)
          const busy = busyTurn === summary.turn
          const isTip = summary.tip
          return <li
            key={`${summary.turn}:${summary.atSeq}`}
            className={styles.timelineItem}
            data-coverage={coverage}
            data-expanded={open || undefined}
            data-rolled-back={summary.rolledBack || undefined}
            data-tip={isTip || undefined}
          >
            <div className={styles.timelineMain}>
              <button
                type="button"
                className={styles.timelineRow}
                aria-expanded={open}
                onClick={() => { setExpanded(open ? null : summary.turn) }}
              >
                <span className={styles.timelineTurn}>
                  {props.t('rollbackTimelineTurn', { turn: summary.turn })}
                  {isTip
                    ? <span className={styles.timelineTipBadge}>{props.t('rollbackTimelineTip')}</span>
                    : null}
                  {summary.rolledBack && !isTip
                    ? <span className={styles.timelineRolledBackBadge}>
                      {props.t('rollbackTimelineRolledBack')}
                    </span>
                    : null}
                </span>
                <span
                  className={prompt.empty ? styles.timelinePromptEmpty : styles.timelinePromptPreview}
                >
                  {prompt.text}
                </span>
                <span className={styles.timelineTime}>{time}</span>
              </button>
              <div className={styles.timelineActions}>
                {isTip
                  ? <Button
                    type="button"
                    disabled={busy || props.rollback === undefined}
                    onClick={() => { openRestore(summary, 'undo') }}
                  >
                    {props.t('rollbackUndoAction')}
                  </Button>
                  : <Button
                    type="button"
                    disabled={busy || props.rollback === undefined}
                    onClick={() => { openRestore(summary, 'rollback') }}
                  >
                    {props.t('rollbackAction')}
                  </Button>}
              </div>
            </div>
            {!open ? null : <div className={styles.timelineDetail}>
              {summary.promptPreview.length === 0
                ? <p className={styles.timelinePromptEmpty}>{props.t('rollbackTimelineNoPrompt')}</p>
                : <p className={styles.timelinePrompt}>{summary.promptPreview}</p>}
              <p className={styles.timelineDetailMeta}>
                <span className={styles.timelineCoverage} data-coverage={coverage}>
                  {timelineCoverageLabel(summary, props.t)}
                </span>
              </p>
              {summary.files.length === 0
                ? null
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
            </div>}
          </li>
        })}
      </ol>}
  </div>
}
