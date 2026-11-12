import { useEffect, useState } from 'react'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { GuideArtworkBrowser } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  browserAgentBrowsersForPlatform,
  coerceBrowserAgentBrowserForPlatform,
  detectUiPlatform,
  resolveBrowserAgentBrowser,
} from '../../config.ts'
import type { BrowserAgentBrowser } from '../../config.ts'
import type { BrowserAgentSnapshot } from '../../host/rpc.ts'
import { quoteSelectedText } from '../quote/insert.ts'
import { lastQuoteSessionId } from '../quote/session.ts'
import styles from '../styles.module.css'
import {
  agentEnhancerBrowserAgentLaunchBrowser,
  agentEnhancerBrowserAgentQuotePage,
  agentEnhancerBrowserAgentSelectTab,
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
    case 'safari':
      return t('browserAgentBrowser_safari')
    case 'auto':
      return t('browserAgentBrowser_auto')
    default: {
      const _exhaustive: never = browser
      return _exhaustive
    }
  }
}

function isLaunchedBrowser(
  value: string | null | undefined,
): value is 'chrome' | 'edge' | 'safari' {
  return value === 'chrome' || value === 'edge' || value === 'safari'
}

export function BrowserAgentTab(props: BrowserAgentTabProps) {
  const { remote, browserPreference, persistBrowserPreference, t } = props
  const uiPlatform = detectUiPlatform()
  const browserOptions = browserAgentBrowsersForPlatform(uiPlatform)
  const [snapshot, setSnapshot] = useState<BrowserAgentSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [pick, setPick] = useState<BrowserAgentBrowser>(() => (
    coerceBrowserAgentBrowserForPlatform(browserPreference(), uiPlatform)
  ))

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const next = await agentEnhancerBrowserAgentSnapshot.invoke(remote())
        // Do NOT setPick(next.browser) here — a 1s poll was resetting the user's
        // browser choice back to the previous host value before Launch.
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
        if (/WEBKIT_MISSING|npx playwright install webkit/i.test(detail)) {
          setHint(t('browserAgentWebkitMissing'))
          return
        }
        setHint(detail === ''
          ? t('browserAgentLaunchFailed')
          : `${t('browserAgentLaunchFailed')} (${detail})`)
        return
      }
      const launched = result.browser ?? result.snapshot.launchedBrowser
      // Keep picker on what we asked for (and what actually launched).
      if (isLaunchedBrowser(launched)) setPick(launched)
      else setPick(browser)
      persistBrowserPreference?.(browser)
      setHint(isLaunchedBrowser(launched)
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

  const selectTab = async (tabId: number) => {
    setBusy(true)
    setHint(null)
    try {
      const sessionId = lastQuoteSessionId()
      const result = await agentEnhancerBrowserAgentSelectTab.invoke(remote(), {
        tabId,
        ...(sessionId === undefined ? {} : { sessionId }),
      })
      setSnapshot(result.snapshot)
      if (!result.ok) {
        setHint(result.error ?? t('browserAgentSelectTabFailed'))
        return
      }
      setHint(t('browserAgentSelectTabOk').replace('{tabId}', String(result.tabId ?? tabId)))
    } finally {
      setBusy(false)
    }
  }

  const connected = snapshot?.bridge.extensionConnected === true
  const boundTabId = snapshot?.boundTabId ?? null
  const tabs = snapshot?.tabs ?? []
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
            {browserOptions.map(browser => (
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
        {connected ? (
          <div className={styles.browserAgentTabListSection}>
            <p className={styles.browserAgentPaneStatus}>{t('browserAgentTabsTitle')}</p>
            <p className={styles.browserAgentPaneNote}>{t('browserAgentTabsHint')}</p>
            {tabs.length === 0 ? (
              <p className={styles.browserAgentPaneNote}>{t('browserAgentTabsEmpty')}</p>
            ) : (
              <ul className={styles.browserAgentTabList} aria-label={t('browserAgentTabsTitle')}>
                {tabs.map(tab => {
                  const selected = tab.active || tab.tabId === boundTabId
                  const title = tab.title.trim() === '' ? t('browserAgentTabUntitled') : tab.title.trim()
                  return (
                    <li key={tab.tabId} className={styles.browserAgentTabItem}>
                      <button
                        type="button"
                        className={selected
                          ? `${styles.browserAgentTabRow} ${styles.browserAgentTabRowSelected}`
                          : styles.browserAgentTabRow}
                        disabled={busy || selected}
                        aria-current={selected ? 'true' : undefined}
                        onClick={() => { void selectTab(tab.tabId) }}
                      >
                        <span className={styles.browserAgentTabId}>{tab.tabId}</span>
                        <span className={styles.browserAgentTabMeta}>
                          <span className={styles.browserAgentTabTitleText}>{title}</span>
                          <span className={styles.browserAgentTabUrl}>{tab.url}</span>
                        </span>
                        {tab.bound ? (
                          <span className={styles.browserAgentTabBadge}>{t('browserAgentTabBoundBadge')}</span>
                        ) : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        ) : null}
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
