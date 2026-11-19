import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RunProgressResult, RunProgressStageWire } from '../../host/rpc.ts'
import { agentEnhancerRunProgress } from '../remote.ts'
import styles from '../styles.module.css'
import { stageVerb, summarizeRun, type StageVerb } from './summary.ts'

export interface RunProgressChipProps {
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

function stageLabel(t: RunProgressChipProps['t'], stage: RunProgressStageWire): string {
  return `${t(VERB_KEYS[stageVerb(stage.tool)])} ${stage.detail ?? stage.tool}`.trim()
}

/**
 * Composer tool-row chip, the way agent clients show a live run: a compact
 * "what it is doing · 3/7" pill that opens a floating list of the stages that
 * actually ran. Hidden while idle — the transcript already owns that history.
 */
export function RunProgressChip(props: RunProgressChipProps) {
  const [view, setView] = useState<RunProgressResult | null>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ readonly left: number; readonly bottom: number } | null>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target === null) return
      if (popRef.current?.contains(target) === true || chipRef.current?.contains(target) === true) return
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const stages = view?.stages ?? []
  if (!enabled || view === null || !view.active) return null
  const summary = summarizeRun(stages)
  const headline = summary.current === undefined
    ? props.t('runProgressThinking')
    : stageLabel(props.t, summary.current)

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = chipRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const width = Math.min(340, window.innerWidth - 16)
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)
    setPos({ left, bottom: window.innerHeight - rect.top + 8 })
    setOpen(true)
  }

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={styles.runProgressChip}
        aria-expanded={open}
        aria-label={props.t('runProgressExpand')}
        title={props.t('runProgressExpand')}
        onClick={toggle}
      >
        <span className={styles.runProgressChipDot} aria-hidden="true" />
        <span className={styles.runProgressChipText}>{headline}</span>
      </button>
      {open && pos !== null ? createPortal(
        <div
          ref={popRef}
          className={styles.runProgressPopover}
          role="dialog"
          aria-label={props.t('runProgress')}
          style={{ left: pos.left, bottom: pos.bottom }}
        >
          <div className={styles.runProgressPopoverHead}>
            <span>{summary.running ? props.t('runProgressRunning') : props.t('runProgressFinished')}</span>
            <span>
              {props.t('runProgressSteps').replace('{n}', String(summary.total))}
              {summary.failed > 0
                ? ` · ${props.t('runProgressFailed').replace('{n}', String(summary.failed))}`
                : ''}
            </span>
          </div>
          {stages.length === 0 ? (
            <p className={styles.runProgressEmpty}>{props.t('runProgressThinking')}</p>
          ) : (
            <ol className={styles.runProgressList}>
              {stages.slice(-MAX_LISTED).map(stage => (
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
          )}
        </div>,
        document.body,
      ) : null}
    </>
  )
}
