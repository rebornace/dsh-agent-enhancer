import { useEffect, useState } from 'react'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { GuideArtworkBrowser } from '@deepseek-ai/dsh-client-ui-primitives'
import { BROWSER_AGENT_BROWSERS, resolveBrowserAgentBrowser } from '../../config.ts'
import type { BrowserAgentBrowser } from '../../config.ts'
import type { BrowserAgentSnapshot } from '../../host/rpc.ts'
import { quoteSelectedText } from '../quote/insert.ts'
import { lastQuoteSessionId } from '../quote/session.ts'
import styles from '../styles.module.css'
import {
  agentEnhancerBrowserAgentLaunchBrowser,
  agentEnhancerBrowserAgentQuotePage,
  agentEnhancerBrowserAgentSetBrowser,
  agentEnhancerBrowserAgentSnapshot,
} from '../remote.ts'

export interface BrowserAgentTabProps extends PropsRuntime<'sidebar.right.pane.tab'> {
  readonly remote: () => { readonly agentEnhancer: object } | undefined
  readonly browserPreference: () => BrowserAgentBrowser
  /** Optional: persist preference after a successful launch (not on every select). */
  readonly persistBrowserPreference?: (browser: BrowserAgentBrowser) => void
  readonly t: TranslateNS<'agent-enhancer'>
}

function browserLabel(browser: BrowserAgentBrowser, t: TranslateNS<'agent-enhancer'>): string {
  switch (browser) {
    case 'chrome':
      return t('browserAgentBrowser_chrome')
    case 'edge':
      return t('browserAgentBrowser_edge')
    default:
      return t('browserAgentBrowser_auto')
  }
}

export function BrowserAgentTab(props: BrowserAgentTabProps) {
  const { remote, browserPreference, persistBrowserPreference, t } = props
  const [snapshot, setSnapshot] = useState<BrowserAgentSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [pick, setPick] = useState<BrowserAgentBrowser>(() => browserPreference())

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const next = await agentEnhancerBrowserAgentSnapshot.invoke(remote())
        // Do NOT setPick(next.browser) here — a 1s poll was resetting the user's
        // Chrome/Edge choice back to the previous host value before Launch.
        if (!cancelled) setSnapshot(next)
      } catch {
        if (!cancelled) setSnapshot(null)
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [remote])

  const launch = async () => {
    setBusy(true)
    setHint(null)
    const browser = pick
    try {
      const result = await agentEnhancerBrowserAgentLaunchBrowser.invoke(remote(), { browser })
      setSnapshot(result.snapshot)
      if (!result.ok) {
        const detail = result.error?.trim() ?? ''
        setHint(detail === ''
          ? t('browserAgentLaunchFailed')
          : `${t('browserAgentLaunchFailed')} (${detail})`)
        return
      }
      const launched = result.browser ?? result.snapshot.launchedBrowser
      // Keep picker on what we asked for (and what actually launched).
      if (launched === 'chrome' || launched === 'edge') setPick(launched)
      else setPick(browser)
      persistBrowserPreference?.(browser)
      setHint(launched === 'chrome' || launched === 'edge'
        ? `${t('browserAgentLaunchStarted')} (${browserLabel(launched, t)})`
        : t('browserAgentLaunchStarted'))
    } finally {
      setBusy(false)
    }
  }

  const quotePage = async () => {
    const sessionId = lastQuoteSessionId()
    if (sessionId === undefined) {
      setHint(t('browserAgentQuoteNoSession'))
      return
    }
    setBusy(true)
    setHint(null)
    try {
      const result = await agentEnhancerBrowserAgentQuotePage.invoke(remote(), { sessionId })
      setSnapshot(result.snapshot)
      if (!result.ok || result.text === undefined || result.text.trim() === '') {
        setHint(result.error ?? t('browserAgentQuoteFailed'))
        return
      }
      const inserted = quoteSelectedText(result.text, sessionId)
      setHint(inserted ? t('browserAgentQuoteOk') : t('browserAgentQuoteFailed'))
    } finally {
      setBusy(false)
    }
  }

  const connected = snapshot?.bridge.extensionConnected === true
  const boundTabId = snapshot?.boundTabId ?? null
  const launched = snapshot?.launchedBrowser
  const statusLabel = snapshot === null
    ? t('browserAgentSidebarLoading')
    : connected
      ? (boundTabId === null
        ? t('browserAgentSidebarConnected')
        : t('browserAgentBoundTab').replace('{tabId}', String(boundTabId)))
      : t('browserAgentSidebarDisconnected')

  return (
    <div className={styles.browserAgentPane}>
      <div className={styles.browserAgentPaneHeader}>
        <span className={styles.browserAgentPaneTitle}>{t('browserAgent')}</span>
      </div>
      <div className={styles.browserAgentPaneBody}>
        <p className={styles.browserAgentPaneStatus}>{statusLabel}</p>
        <p className={styles.browserAgentPaneNote}>{t('browserAgentSwitchHint')}</p>
        <label className={styles.browserAgentExtraRow}>
          <span>{t('browserAgentBrowser')}</span>
          <select
            className={styles.settingsSelect}
            aria-label={t('browserAgentBrowser')}
            disabled={busy}
            value={pick}
            onChange={event => {
              const next = resolveBrowserAgentBrowser(event.target.value)
              setPick(next)
              // Sync host live preference immediately (Agent dialog reads this),
              // then persist Cordis so Settings stays in sync.
              void agentEnhancerBrowserAgentSetBrowser.invoke(remote(), { browser: next })
              persistBrowserPreference?.(next)
            }}
          >
            {BROWSER_AGENT_BROWSERS.map(browser => (
              <option key={browser} value={browser}>
                {browserLabel(browser, t)}
              </option>
            ))}
          </select>
        </label>
        {launched !== null && launched !== undefined ? (
          <p className={styles.browserAgentPaneNote}>
            {t('browserAgentRunningAs')}: {browserLabel(launched, t)}
          </p>
        ) : null}
        <div className={styles.browserAgentActions}>
          <button
            type="button"
            className={styles.browserAgentButton}
            disabled={busy}
            onClick={() => { void launch() }}
          >
            {t('browserAgentLaunch')}
          </button>
          {connected ? (
            <button
              type="button"
              className={styles.browserAgentButton}
              disabled={busy}
              onClick={() => { void quotePage() }}
            >
              {t('browserAgentQuotePage')}
            </button>
          ) : null}
        </div>
        {hint !== null ? (
          <p className={styles.browserAgentPaneNote}>{hint}</p>
        ) : null}
        <p className={styles.browserAgentPaneNote}>{t('browserAgentOpenLinkHint')}</p>
        <p className={styles.browserAgentPaneNote}>{t('browserAgentSidebarChatHint')}</p>
      </div>
    </div>
  )
}

export function BrowserAgentTabTitle(props: PropsRuntime<'sidebar.right.pane.tab.title'> & {
  readonly t: TranslateNS<'agent-enhancer'>
}) {
  return (
    <>
      <GuideArtworkBrowser size={16} className={styles.browserAgentTitleIcon} />
      <span>{props.t('browserAgent')}</span>
    </>
  )
}
