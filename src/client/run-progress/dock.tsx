import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useState } from 'react'
import type { RunProgressResult, RunProgressStageWire } from '../../host/rpc.ts'
import { agentEnhancerRunProgress } from '../remote.ts'
import styles from '../styles.module.css'
import { stageVerb, summarizeRun, type StageVerb } from './summary.ts'

export interface RunProgressDockProps {
  readonly t: TranslateNS<'agent-enhancer'>
  readonly getRemote: () => unknown
  readonly sessionId?: string
  readonly enabled?: () => boolean
}

const VERB_KEYS: Record<StageVerb, 'runProgressVerbShell' | 'runProgressVerbRead' | 'runProgressVerbWrite' | 'runProgressVerbBrowser' | 'runProgressVerbOther'> = {
  shell: 'runProgressVerbShell',
  read: 'runProgressVerbRead',
  write: 'runProgressVerbWrite',
  browser: 'runProgressVerbBrowser',
  other: 'runProgressVerbOther',
}

const MAX_LISTED = 12

function stageLabel(t: RunProgressDockProps['t'], stage: RunProgressStageWire): string {
  return `${t(VERB_KEYS[stageVerb(stage.tool)])} ${stage.detail ?? stage.tool}`.trim()
}

/**
 * Ambient stage list above the composer: derived from tool calls that actually
 * ran, so it cannot drift from the turn. Collapsed to one line while running,
 * expandable; idle shows the finished count and collapses itself.
 */
export function RunProgressDock(props: RunProgressDockProps) {
  const [view, setView] = useState<RunProgressResult | null>(null)
  const [open, setOpen] = useState(false)
  const sessionId = props.sessionId
  const enabled = props.enabled?.() !== false

  useEffect(() => {
    if (sessionId === undefined || !enabled) {
      setView(null)
      return
    }
    let cancelled = false
    const tick = async () => {
      const next = await agentEnhancerRunProgress.invoke(props.getRemote(), { sessionId })
      if (!cancelled) setView(next)
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 1_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId, enabled, props.getRemote])

  const stages = view?.stages ?? []
  if (!enabled || stages.length === 0) return null

  const summary = summarizeRun(stages)
  const current = summary.current
  const listed = stages.slice(-MAX_LISTED)
  const headline = current !== undefined
    ? `${props.t('runProgressRunning')} · ${stageLabel(props.t, current)} · ${summary.done}/${summary.total}`
    : `${props.t('runProgressFinished')} · ${summary.total}${summary.failed > 0
      ? ` · ${props.t('runProgressFailed').replace('{n}', String(summary.failed))}`
      : ''}`

  return (
    <div className={styles.runProgressDock} data-running={summary.running ? 'true' : undefined}>
      <button
        type="button"
        className={styles.runProgressLine}
        aria-expanded={open}
        title={open ? props.t('runProgressCollapse') : props.t('runProgressExpand')}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className={styles.runProgressDot} aria-hidden="true" />
        <span className={styles.runProgressText}>{headline}</span>
        <span className={styles.runProgressChevron} aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <ol className={styles.runProgressList}>
          {listed.map(stage => (
            <li key={stage.id} className={styles.runProgressItem} data-status={stage.status}>
              <span className={styles.runProgressGlyph} aria-hidden="true">
                {stage.status === 'running' ? '●' : stage.status === 'failed' ? '✕' : '✓'}
              </span>
              <span className={styles.runProgressItemText}>{stageLabel(props.t, stage)}</span>
              {stage.error === undefined ? null : (
                <span className={styles.runProgressError}>{stage.error}</span>
              )}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
