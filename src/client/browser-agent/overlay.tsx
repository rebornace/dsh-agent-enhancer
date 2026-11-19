import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useId, useRef, useState } from 'react'
import { approvalKeyDecision } from './approval-keys.ts'
import { BANNER_GAP, bannerRightInset } from './banner-geometry.ts'
import type { BrowserAgentSnapshot } from '../../host/rpc.ts'
import {
  agentEnhancerBrowserAgentAcknowledgeHuman,
  agentEnhancerBrowserAgentResolve,
  agentEnhancerBrowserAgentResolveTabConflict,
  agentEnhancerBrowserAgentSnapshot,
  agentEnhancerBrowserAgentThumbnail,
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
  const [rightInset, setRightInset] = useState(BANNER_GAP)
  const [thumb, setThumb] = useState<{ readonly mime: string; readonly base64: string } | null>(null)
  const humanContinueRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const bodyId = useId()

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

  useEffect(() => {
    // Keep the card clear of the right sidebar: it is a layout column, so a
    // viewport-fixed card would otherwise sit on top of it.
    const measure = () => {
      const panel = document.querySelector('[data-sidebar-right-open]')
      const width = panel instanceof HTMLElement ? panel.getBoundingClientRect().width : 0
      setRightInset(bannerRightInset(width, window.innerWidth))
    }
    measure()
    const timer = setInterval(measure, 500)
    return () => {
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    // One fetch per approval: the crop lives on the host and is dropped when the
    // request resolves, so it never rides along in the 800 ms snapshot poll.
    const id = snapshot?.pending?.id ?? null
    if (id === null || snapshot?.pending?.hasThumbnail !== true) {
      setThumb(null)
      return
    }
    let cancelled = false
    setThumb(null)
    void agentEnhancerBrowserAgentThumbnail.invoke(props.getRemote(), { id }).then(result => {
      if (cancelled) return
      setThumb(result.ok && result.base64 !== undefined && result.base64 !== ''
        ? { mime: result.mime ?? 'image/jpeg', base64: result.base64 }
        : null)
    }).catch(() => {
      if (!cancelled) setThumb(null)
    })
    return () => {
      cancelled = true
    }
  }, [snapshot?.pending?.id, snapshot?.pending?.hasThumbnail, props.getRemote])

  if (snapshot === null || !snapshot.enabled) return null

  const key = panelKey(snapshot)
  if (key === null || dismissedKey === key) return null

  const dismiss = () => {
    setDismissedKey(key)
  }

  const header = (title: string, headingId?: string) => (
    <div className={styles.browserAgentHeader}>
      <div className={styles.browserAgentTitle} id={headingId}>{title}</div>
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
      <div className={styles.browserAgentBanner} role="status" aria-live="polite" style={{ right: rightInset }}>
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
    // Keyboard: Enter allows this once, Esc denies — without stealing focus
    // from the composer (guarded against typing targets below).
    return (
      <div
        className={styles.browserAgentBanner}
        role="status"
        aria-live="polite"
        style={{ right: rightInset }}
      >
        <ApprovalKeys
          busy={busy}
          onAllow={() => { void resolve('allow-once') }}
          onDeny={() => { void resolve('deny') }}
        />
        {header(props.t('browserAgentApproveTitle'))}
        {thumb === null ? null : (
          <img
            className={styles.browserAgentThumb}
            src={`data:${thumb.mime};base64,${thumb.base64}`}
            alt={props.t('browserAgentApproveThumbAlt')}
          />
        )}
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
        <p className={styles.browserAgentKeyHint}>{props.t('browserAgentApproveKeys')}</p>
      </div>
    )
  }

  if (snapshot.needsHuman !== null) {
    const needsHuman = snapshot.needsHuman
    const acknowledge = async () => {
      setBusy(true)
      try {
        const result = await agentEnhancerBrowserAgentAcknowledgeHuman.invoke(props.getRemote(), {
          sessionId: needsHuman.sessionId,
        })
        setSnapshot(result.snapshot)
      } finally {
        setBusy(false)
      }
    }
    // Login/captcha gets the wall-specific wording; anything else the agent asked
    // for (close a tab, toggle a switch) shows only that instruction.
    const asksHuman = needsHuman.kind === 'human'
    return (
      <NeedsHumanBanner
        titleId={titleId}
        rightInset={rightInset}
        bodyId={bodyId}
        title={asksHuman ? props.t('browserAgentNeedsHumanTitle') : props.t('browserAgentAskTitle')}
        body={asksHuman ? props.t('browserAgentNeedsHumanBody') : needsHuman.detail}
        detail={asksHuman ? needsHuman.detail : ''}
        continueLabel={asksHuman
          ? props.t('browserAgentNeedsHumanContinue')
          : props.t('browserAgentAskContinue')}
        closeLabel={props.t('browserAgentClose')}
        busy={busy}
        continueRef={humanContinueRef}
        onDismiss={dismiss}
        onContinue={() => { void acknowledge() }}
      />
    )
  }

  return null
}

/**
 * Global Enter/Esc for the approval card. Deliberately a child component so the
 * window listener lives exactly as long as the card: the parent cannot call a
 * hook inside its `pending !== null` branch.
 */
function ApprovalKeys(props: {
  readonly busy: boolean
  readonly onAllow: () => void
  readonly onDeny: () => void
}) {
  const handlers = useRef(props)
  handlers.current = props
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const decision = approvalKeyDecision({
        key: event.key,
        ...(target?.tagName === undefined ? {} : { tagName: target.tagName }),
        ...(target?.isContentEditable === true ? { contentEditable: true } : {}),
        busy: handlers.current.busy,
        defaultPrevented: event.defaultPrevented,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
      })
      if (decision === null) return
      event.preventDefault()
      if (decision === 'deny') handlers.current.onDeny()
      else handlers.current.onAllow()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])
  return null
}

function NeedsHumanBanner(props: {
  readonly titleId: string
  readonly rightInset: number
  readonly bodyId: string
  readonly title: string
  readonly body: string
  readonly detail: string
  readonly continueLabel: string
  readonly closeLabel: string
  readonly busy: boolean
  readonly continueRef: { readonly current: HTMLButtonElement | null }
  readonly onDismiss: () => void
  readonly onContinue: () => void
}) {
  useEffect(() => {
    props.continueRef.current?.focus()
  }, [props.continueRef, props.detail])

  return (
    <div
      className={styles.browserAgentBanner}
      role="alertdialog"
      aria-modal="true"
      style={{ right: props.rightInset }}
      aria-labelledby={props.titleId}
      aria-describedby={props.bodyId}
      aria-live="assertive"
    >
      <div className={styles.browserAgentHeader}>
        <div className={styles.browserAgentTitle} id={props.titleId}>{props.title}</div>
        <button
          type="button"
          className={styles.browserAgentClose}
          aria-label={props.closeLabel}
          title={props.closeLabel}
          onClick={props.onDismiss}
        >
          ×
        </button>
      </div>
      <p className={styles.browserAgentBody} id={props.bodyId}>{props.body}</p>
      <p className={styles.browserAgentMeta}>{props.detail}</p>
      <div className={styles.browserAgentActions}>
        <button
          ref={props.continueRef}
          type="button"
          className={styles.browserAgentButton}
          disabled={props.busy}
          onClick={props.onContinue}
        >
          {props.continueLabel}
        </button>
      </div>
    </div>
  )
}
