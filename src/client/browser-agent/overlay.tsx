import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useState } from 'react'
import type { BrowserAgentSnapshot } from '../../host/rpc.ts'
import {
  agentEnhancerBrowserAgentAcknowledgeHuman,
  agentEnhancerBrowserAgentResolve,
  agentEnhancerBrowserAgentResolveTabConflict,
  agentEnhancerBrowserAgentSnapshot,
} from '../remote.ts'
import styles from '../styles.module.css'

export interface BrowserAgentOverlayProps {
  readonly t: TranslateNS<'agent-enhancer'>
  readonly getRemote: () => unknown
}

function panelKey(snapshot: BrowserAgentSnapshot): string | null {
  if (snapshot.tabConflict !== null) {
    const conflict = snapshot.tabConflict
    return `conflict:${conflict.sessionId}:${conflict.boundTabId}:${conflict.activeTabId}`
  }
  if (snapshot.pending !== null) return `pending:${snapshot.pending.id}`
  if (snapshot.needsHuman !== null) {
    return `human:${snapshot.needsHuman.sessionId}:${snapshot.needsHuman.detail}`
  }
  // No “launch” card — Agent tools / Alt+click auto-launch the dedicated browser.
  return null
}

export function BrowserAgentOverlay(props: BrowserAgentOverlayProps) {
  const [snapshot, setSnapshot] = useState<BrowserAgentSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const next = await agentEnhancerBrowserAgentSnapshot.invoke(props.getRemote())
        if (!cancelled) setSnapshot(next)
      } catch {
        if (!cancelled) setSnapshot(null)
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 800)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [props.getRemote])

  if (snapshot === null || !snapshot.enabled) return null

  const key = panelKey(snapshot)
  if (key === null || dismissedKey === key) return null

  const dismiss = () => {
    setDismissedKey(key)
  }

  const header = (title: string) => (
    <div className={styles.browserAgentHeader}>
      <div className={styles.browserAgentTitle}>{title}</div>
      <button
        type="button"
        className={styles.browserAgentClose}
        aria-label={props.t('browserAgentClose')}
        title={props.t('browserAgentClose')}
        onClick={dismiss}
      >
        ×
      </button>
    </div>
  )

  const conflict = snapshot.tabConflict
  if (conflict !== null) {
    const resolveConflict = async (decision: 'follow' | 'stay') => {
      setBusy(true)
      try {
        const result = await agentEnhancerBrowserAgentResolveTabConflict.invoke(props.getRemote(), {
          decision,
        })
        setSnapshot(result.snapshot)
      } finally {
        setBusy(false)
      }
    }
    return (
      <div className={styles.browserAgentBanner} role="status">
        {header(props.t('browserAgentTabConflictTitle'))}
        <p className={styles.browserAgentBody}>
          {props.t('browserAgentTabConflictBody')
            .replace('{bound}', String(conflict.boundTabId))
            .replace('{active}', String(conflict.activeTabId))}
        </p>
        <div className={styles.browserAgentActions}>
          <button type="button" className={styles.browserAgentButton} disabled={busy} onClick={() => { void resolveConflict('follow') }}>
            {props.t('browserAgentTabFollow')}
          </button>
          <button type="button" className={styles.browserAgentButton} disabled={busy} onClick={() => { void resolveConflict('stay') }}>
            {props.t('browserAgentTabStay')}
          </button>
        </div>
      </div>
    )
  }

  if (snapshot.pending !== null) {
    const pending = snapshot.pending
    const resolve = async (decision: 'allow-once' | 'allow-origin' | 'deny') => {
      setBusy(true)
      try {
        const result = await agentEnhancerBrowserAgentResolve.invoke(props.getRemote(), {
          id: pending.id,
          decision,
        })
        setSnapshot(result.snapshot)
      } finally {
        setBusy(false)
      }
    }
    return (
      <div className={styles.browserAgentBanner} role="status">
        {header(props.t('browserAgentApproveTitle'))}
        <p className={styles.browserAgentBody}>{pending.summary}</p>
        {pending.url !== undefined && pending.url.trim() !== '' ? (
          <p className={styles.browserAgentMeta}>{pending.url}</p>
        ) : null}
        <div className={styles.browserAgentActions}>
          <button type="button" className={styles.browserAgentButton} disabled={busy} onClick={() => { void resolve('allow-once') }}>
            {props.t('browserAgentAllowOnce')}
          </button>
          <button type="button" className={styles.browserAgentButton} disabled={busy} onClick={() => { void resolve('allow-origin') }}>
            {props.t('browserAgentAllowOrigin')}
          </button>
          <button type="button" className={styles.browserAgentButton} disabled={busy} onClick={() => { void resolve('deny') }}>
            {props.t('browserAgentDeny')}
          </button>
        </div>
      </div>
    )
  }

  if (snapshot.needsHuman !== null) {
    const acknowledge = async () => {
      setBusy(true)
      try {
        const result = await agentEnhancerBrowserAgentAcknowledgeHuman.invoke(props.getRemote(), {
          sessionId: snapshot.needsHuman!.sessionId,
        })
        setSnapshot(result.snapshot)
      } finally {
        setBusy(false)
      }
    }
    return (
      <div className={styles.browserAgentBanner} role="status">
        {header(props.t('browserAgentNeedsHumanTitle'))}
        <p className={styles.browserAgentBody}>{props.t('browserAgentNeedsHumanBody')}</p>
        <p className={styles.browserAgentMeta}>{snapshot.needsHuman.detail}</p>
        <div className={styles.browserAgentActions}>
          <button type="button" className={styles.browserAgentButton} disabled={busy} onClick={() => { void acknowledge() }}>
            {props.t('browserAgentNeedsHumanContinue')}
          </button>
        </div>
      </div>
    )
  }

  return null
}
