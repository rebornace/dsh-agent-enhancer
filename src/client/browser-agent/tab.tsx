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
import type { BrowserAgentSnapshot, DemoRecipeMetaWire } from '../../host/rpc.ts'
import { quoteSelectedText } from '../quote/insert.ts'
import { lastQuoteSessionId } from '../quote/session.ts'
import styles from '../styles.module.css'
import {
  agentEnhancerBrowserAgentLaunchBrowser,
  agentEnhancerBrowserAgentDemo,
  agentEnhancerBrowserAgentDemoRecipes,
  agentEnhancerBrowserAgentQuotePage,
  agentEnhancerBrowserAgentSelectTab,
  agentEnhancerBrowserAgentSetBrowser,
  agentEnhancerBrowserAgentSetTabReadOnly,
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
        // Do NOT setPick(next.browser) here 鈥?a 1s poll was resetting the user's
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

  const toggleReadOnly = async (tabId: number, readOnly: boolean) => {
    setBusy(true)
    setHint(null)
    try {
      const result = await agentEnhancerBrowserAgentSetTabReadOnly.invoke(remote(), { tabId, readOnly })
      setSnapshot(result.snapshot)
      setHint(result.ok
        ? (readOnly ? t('browserAgentTabReadOnlyOk') : t('browserAgentTabReadOnlyOff')).replace('{tabId}', String(tabId))
        : (result.error ?? t('browserAgentTabReadOnlyFailed')))
    } finally {
      setBusy(false)
    }
  }

  const [demoSteps, setDemoSteps] = useState<readonly string[] | null>(null)

  const runDemo = async (action: 'start' | 'stop') => {
    setBusy(true)
    setHint(null)
    try {
      const result = await agentEnhancerBrowserAgentDemo.invoke(remote(), { action })
      setSnapshot(result.snapshot)
      if (!result.ok) {
        setHint(result.error ?? t('browserAgentDemoFailed'))
        return
      }
      if (action === 'stop') setDemoSteps(result.steps ?? [])
    } finally {
      setBusy(false)
    }
  }

  const [recipes, setRecipes] = useState<readonly DemoRecipeMetaWire[]>([])
  const [recipeName, setRecipeName] = useState('')
  const [recipeBusy, setRecipeBusy] = useState(false)
  const [openRecipeId, setOpenRecipeId] = useState<string | null>(null)
  const [recipeStepRows, setRecipeStepRows] = useState<readonly {
    readonly index: number
    readonly kind: string
    readonly label: string
    readonly canParameterize: boolean
  }[]>([])
  const [paramBusyIndex, setParamBusyIndex] = useState<number | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<{
    readonly recipeId: string
    readonly items: readonly { readonly index: number; readonly label: string; readonly value: string }[]
  } | null>(null)
  const [varsFor, setVarsFor] = useState<string | null>(null)
  const [varsValues, setVarsValues] = useState<Record<string, string>>({})
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const loadRecipes = async () => {
    const result = await agentEnhancerBrowserAgentDemoRecipes.invoke(remote(), { action: 'list' })
    if (result.recipes !== undefined) setRecipes(result.recipes)
  }

  useEffect(() => {
    if (snapshot?.demo.enabled === true) void loadRecipes()
  }, [snapshot?.demo.enabled])

  // The host bumps this whenever a flow changes (a repair offered by the agent,
  // an accepted fix, a rollback). Polling the list itself would be wasteful.
  const recipesVersion = snapshot?.demo.recipesVersion ?? 0
  useEffect(() => {
    if (snapshot?.demo.enabled !== true) return
    void loadRecipes()
  }, [recipesVersion])

  const saveRecipe = async () => {
    const name = recipeName.trim()
    if (name === '') {
      setHint(t('browserAgentDemoRecipeNameRequired'))
      return
    }
    setRecipeBusy(true)
    setHint(null)
    try {
      const result = await agentEnhancerBrowserAgentDemoRecipes.invoke(remote(), { action: 'save', name })
      if (result.recipes !== undefined) setRecipes(result.recipes)
      if (!result.ok) {
        setHint(result.error ?? t('browserAgentDemoRecipeFailed'))
        return
      }
      setRecipeName('')
      const items = result.suggestions ?? []
      setSuggestions(result.recipe !== undefined && items.length > 0
        ? { recipeId: result.recipe.id, items }
        : null)
      setHint(t('browserAgentDemoRecipeSaved').replace('{name}', result.recipe?.name ?? name))
    } finally {
      setRecipeBusy(false)
    }
  }

  const runRecipe = async (recipe: DemoRecipeMetaWire, values?: Record<string, string>) => {
    setRecipeBusy(true)
    setHint(null)
    try {
      const result = await agentEnhancerBrowserAgentDemoRecipes.invoke(remote(), {
        action: 'run',
        id: recipe.id,
        ...(values === undefined ? {} : { vars: values }),
      })
      if (result.recipes !== undefined) setRecipes(result.recipes)
      if (!result.ok) {
        setHint(result.error ?? t('browserAgentDemoRecipeFailed'))
        return
      }
      setHint(result.stoppedAt === undefined
        ? t('browserAgentDemoRecipeRan')
          .replace('{name}', recipe.name)
          .replace('{n}', String(result.lines?.length ?? 0))
        : t('browserAgentDemoRecipeStopped')
          .replace('{step}', String(result.stoppedAt))
          .replace('{reason}', result.reason ?? ''))
    } finally {
      setRecipeBusy(false)
    }
  }

  const deleteRecipe = async (recipe: DemoRecipeMetaWire) => {
    setRecipeBusy(true)
    setHint(null)
    try {
      const result = await agentEnhancerBrowserAgentDemoRecipes.invoke(remote(), { action: 'delete', id: recipe.id })
      if (result.recipes !== undefined) setRecipes(result.recipes)
      if (!result.ok) setHint(result.error ?? t('browserAgentDemoRecipeFailed'))
    } finally {
      setRecipeBusy(false)
    }
  }


  const toggleRecipeSteps = async (recipe: DemoRecipeMetaWire) => {
    if (openRecipeId === recipe.id) {
      setOpenRecipeId(null)
      return
    }
    const result = await agentEnhancerBrowserAgentDemoRecipes.invoke(remote(), { action: 'steps', id: recipe.id })
    if (!result.ok) {
      setHint(result.error ?? t('browserAgentDemoRecipeFailed'))
      return
    }
    setRecipeStepRows(result.steps ?? [])
    setMenuFor(null)
    setOpenRecipeId(recipe.id)
  }

  /** Turn one recorded value into a variable. The label comes from the page. */
  const parameterizeStep = async (recipe: DemoRecipeMetaWire, index: number, label?: string) => {
    setParamBusyIndex(index)
    setRecipeBusy(true)
    setHint(null)
    try {
      const result = await agentEnhancerBrowserAgentDemoRecipes.invoke(remote(), {
        action: 'parameterize',
        id: recipe.id,
        index,
        ...(label === undefined ? {} : { label }),
      })
      if (result.recipes !== undefined) setRecipes(result.recipes)
      if (!result.ok) {
        setHint(result.error ?? t('browserAgentDemoRecipeFailed'))
        return
      }
      const applied = result.recipe?.variables[result.recipe.variables.length - 1]
      const refreshed = await agentEnhancerBrowserAgentDemoRecipes.invoke(remote(), { action: 'steps', id: recipe.id })
      if (refreshed.steps !== undefined) setRecipeStepRows(refreshed.steps)
      setSuggestions(previous => previous === null
        ? null
        : { ...previous, items: previous.items.filter(item => item.index !== index) })
      setHint(t('browserAgentDemoRecipeParameterized').replace('{name}', applied?.label ?? ''))
    } finally {
      setParamBusyIndex(null)
      setRecipeBusy(false)
    }
  }

  const updateVariable = async (
    recipe: DemoRecipeMetaWire,
    name: string,
    patch: { readonly label?: string; readonly default?: string; readonly ask?: boolean },
  ) => {
    setRecipeBusy(true)
    setHint(null)
    try {
      const result = await agentEnhancerBrowserAgentDemoRecipes.invoke(remote(), {
        action: 'variable',
        id: recipe.id,
        name,
        ...patch,
      })
      if (result.recipes !== undefined) setRecipes(result.recipes)
      if (!result.ok) setHint(result.error ?? t('browserAgentDemoRecipeFailed'))
    } finally {
      setRecipeBusy(false)
    }
  }

  const removeVariable = async (recipe: DemoRecipeMetaWire, name: string) => {
    setRecipeBusy(true)
    setHint(null)
    try {
      const result = await agentEnhancerBrowserAgentDemoRecipes.invoke(remote(), {
        action: 'unvariable',
        id: recipe.id,
        name,
      })
      if (result.recipes !== undefined) setRecipes(result.recipes)
      if (!result.ok) {
        setHint(result.error ?? t('browserAgentDemoRecipeFailed'))
        return
      }
      const refreshed = await agentEnhancerBrowserAgentDemoRecipes.invoke(remote(), { action: 'steps', id: recipe.id })
      if (refreshed.steps !== undefined) setRecipeStepRows(refreshed.steps)
      setHint(t('browserAgentDemoVarReverted'))
    } finally {
      setRecipeBusy(false)
    }
  }

  const setUnattended = async (recipe: DemoRecipeMetaWire, unattended: boolean) => {
    setRecipeBusy(true)
    setHint(null)
    try {
      const result = await agentEnhancerBrowserAgentDemoRecipes.invoke(remote(), {
        action: 'unattended',
        id: recipe.id,
        unattended,
      })
      if (result.recipes !== undefined) setRecipes(result.recipes)
      if (!result.ok) setHint(result.error ?? t('browserAgentDemoRecipeFailed'))
    } finally {
      setRecipeBusy(false)
    }
  }

  /** Accept the repair the agent worked out, or drop it and keep the flow as is. */
  const resolveHeal = async (recipe: DemoRecipeMetaWire, accept: boolean) => {
    setRecipeBusy(true)
    setHint(null)
    try {
      const result = await agentEnhancerBrowserAgentDemoRecipes.invoke(remote(), {
        action: 'heal',
        id: recipe.id,
        accept,
      })
      if (result.recipes !== undefined) setRecipes(result.recipes)
      if (!result.ok) {
        setHint(result.error ?? t('browserAgentDemoRecipeFailed'))
        return
      }
      if (accept && openRecipeId === recipe.id) {
        const refreshed = await agentEnhancerBrowserAgentDemoRecipes.invoke(remote(), { action: 'steps', id: recipe.id })
        if (refreshed.steps !== undefined) setRecipeStepRows(refreshed.steps)
      }
      setHint(accept ? t('browserAgentDemoHealKept') : t('browserAgentDemoHealSkipped'))
    } finally {
      setRecipeBusy(false)
    }
  }

  const rollbackRecipe = async (recipe: DemoRecipeMetaWire) => {
    setRecipeBusy(true)
    setHint(null)
    try {
      const result = await agentEnhancerBrowserAgentDemoRecipes.invoke(remote(), { action: 'rollback', id: recipe.id })
      if (result.recipes !== undefined) setRecipes(result.recipes)
      if (!result.ok) {
        setHint(result.error ?? t('browserAgentDemoRecipeFailed'))
        return
      }
      const refreshed = await agentEnhancerBrowserAgentDemoRecipes.invoke(remote(), { action: 'steps', id: recipe.id })
      if (refreshed.steps !== undefined) setRecipeStepRows(refreshed.steps)
      setHint(t('browserAgentDemoRecipeRestored'))
    } finally {
      setRecipeBusy(false)
    }
  }

  const beginRun = (recipe: DemoRecipeMetaWire) => {
    if (recipe.variables.length === 0) {
      void runRecipe(recipe)
      return
    }
    const initial: Record<string, string> = {}
    for (const variable of recipe.variables) initial[variable.name] = variable.ask ? '' : variable.default
    setVarsValues(initial)
    setVarsFor(recipe.id)
    setHint(null)
  }

  const startRename = (recipe: DemoRecipeMetaWire) => {
    setRenamingId(recipe.id)
    setRenameValue(recipe.name)
  }

  const submitRename = async (recipe: DemoRecipeMetaWire) => {
    const name = renameValue.trim()
    if (name === '') {
      setHint(t('browserAgentDemoRecipeNameRequired'))
      return
    }
    setRecipeBusy(true)
    setHint(null)
    try {
      const result = await agentEnhancerBrowserAgentDemoRecipes.invoke(remote(), { action: 'rename', id: recipe.id, name })
      if (result.recipes !== undefined) setRecipes(result.recipes)
      if (!result.ok) {
        setHint(result.error ?? t('browserAgentDemoRecipeFailed'))
        return
      }
      setRenamingId(null)
      setHint(t('browserAgentDemoRecipeRenamed').replace('{name}', result.recipe?.name ?? name))
    } finally {
      setRecipeBusy(false)
    }
  }

  const copyDemoSteps = async () => {
    if (demoSteps === null || demoSteps.length === 0) return
    try {
      await navigator.clipboard.writeText(demoSteps.join('\n'))
      setHint(t('browserAgentDemoCopied'))
    } catch {
      setHint(t('browserAgentDemoCopyFailed'))
    }
  }

  /** Hand the steps to the chat composer as a quote, so the agent sees them. */
  const sendDemoSteps = () => {
    if (demoSteps === null || demoSteps.length === 0) return
    const text = [
      t('browserAgentDemoSendLead'),
      ...demoSteps,
    ].join('\n')
    const inserted = quoteSelectedText(text, lastQuoteSessionId())
    setHint(inserted ? t('browserAgentDemoSent') : t('browserAgentDemoSendFailed'))
  }

  const connected = snapshot?.bridge.extensionConnected === true
  const diagnosis = snapshot?.diagnosis
  const diagnosisHint = diagnosis !== undefined && diagnosis.code !== 'ok'
    ? (
      diagnosis.code === 'idle'
        ? t('browserAgentDiagnosis_idle')
        : diagnosis.code === 'disabled'
          ? t('browserAgentDiagnosis_disabled')
          : diagnosis.code === 'webkit_missing'
            ? t('browserAgentDiagnosis_webkit_missing')
            : diagnosis.code === 'browser_missing'
              ? t('browserAgentDiagnosis_browser_missing')
              : diagnosis.code === 'profile_locked'
                ? t('browserAgentDiagnosis_profile_locked')
                : t('browserAgentDiagnosis_launch_failed')
    )
    : null
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
        {diagnosisHint !== null ? (
          <p className={styles.browserAgentPaneNote}>{diagnosisHint}</p>
        ) : null}
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
                      <button
                        type="button"
                        className={tab.readOnly
                          ? `${styles.browserAgentTabGuard} ${styles.browserAgentTabGuardOn}`
                          : styles.browserAgentTabGuard}
                        disabled={busy}
                        aria-pressed={tab.readOnly}
                        title={tab.readOnly ? t('browserAgentTabReadOnlyOff') : t('browserAgentTabReadOnlyOn')}
                        onClick={() => { void toggleReadOnly(tab.tabId, !tab.readOnly) }}
                      >
                        {t('browserAgentTabReadOnlyBadge')}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        ) : null}
        {snapshot?.demo.enabled === true ? (
          <div className={styles.browserAgentDemoSection}>
            <p className={styles.browserAgentPaneStatus}>
              {snapshot.demo.recording ? t('browserAgentDemoRecording') : t('browserAgentDemoTitle')}
            </p>
            <p className={styles.browserAgentPaneNote}>
              {snapshot.demo.recording
                ? (snapshot.needsHuman === null
                  ? t('browserAgentDemoRecordingHint')
                  : t('browserAgentDemoRecordingAgent'))
                : t('browserAgentDemoHint')}
            </p>
            <div className={styles.browserAgentActions}>
              {snapshot.demo.recording
                ? (snapshot.needsHuman === null ? (
                  <button
                    type="button"
                    className={styles.browserAgentButton}
                    disabled={busy}
                    onClick={() => { void runDemo('stop') }}
                  >
                    {t('browserAgentDemoStop')}
                  </button>
                ) : null)
                : (
                  <button
                    type="button"
                    className={styles.browserAgentButton}
                    disabled={busy}
                    onClick={() => { void runDemo('start') }}
                  >
                    {t('browserAgentDemoStart')}
                  </button>
                )}
            </div>
            {demoSteps === null && snapshot.demo.lastSteps > 0 ? (
              <p className={styles.browserAgentPaneNote}>
                {t('browserAgentDemoLastSteps').replace('{n}', String(snapshot.demo.lastSteps))}
              </p>
            ) : null}
            {(demoSteps !== null && demoSteps.length > 0) || snapshot.demo.lastSteps > 0 ? (
              <div className={styles.browserAgentDemoSave}>
                <input
                  className={styles.browserAgentDemoName}
                  value={recipeName}
                  placeholder={t('browserAgentDemoRecipeName')}
                  aria-label={t('browserAgentDemoRecipeName')}
                  disabled={recipeBusy}
                  onChange={event => { setRecipeName(event.target.value) }}
                />
                <button
                  type="button"
                  className={styles.browserAgentButton}
                  disabled={recipeBusy}
                  onClick={() => { void saveRecipe() }}
                >
                  {t('browserAgentDemoRecipeSave')}
                </button>
              </div>
            ) : null}
            {suggestions === null ? null : (
              <div className={styles.browserAgentHeal}>
                <p className={styles.browserAgentHealText}>{t('browserAgentDemoSuggestTitle')}</p>
                {suggestions.items.map(item => {
                  const recipe = recipes.find(candidate => candidate.id === suggestions.recipeId)
                  return (
                    <div key={`${item.index}-${item.value}`} className={styles.browserAgentRecipeStepRow}>
                      <span className={styles.browserAgentRecipeStepText}>
                        {t('browserAgentDemoSuggestRow')
                          .replace('{value}', item.value)
                          .replace('{label}', item.label)}
                      </span>
                      <button
                        type="button"
                        className={styles.browserAgentButton}
                        disabled={recipeBusy || recipe === undefined}
                        onClick={() => {
                          if (recipe !== undefined) void parameterizeStep(recipe, item.index, item.label)
                        }}
                      >
                        {t('browserAgentDemoSuggestMake')}
                      </button>
                      <button
                        type="button"
                        className={styles.browserAgentButton}
                        disabled={recipeBusy}
                        onClick={() => { setSuggestions(null) }}
                      >
                        {t('browserAgentDemoSuggestKeep')}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
            {recipes.length > 0 ? (
              <div className={styles.browserAgentTabListSection}>
                <p className={styles.browserAgentPaneNote}>{t('browserAgentDemoRecipesTitle')}</p>
                <ul className={styles.browserAgentRecipeList}>
                  {recipes.map(recipe => (
                    <li key={recipe.id} className={styles.browserAgentRecipeItem}>
                      <div className={styles.browserAgentRecipeRow}>
                        {renamingId === recipe.id ? (
                          <>
                            <input
                              className={styles.browserAgentDemoName}
                              value={renameValue}
                              aria-label={t('browserAgentDemoRecipeRename')}
                              disabled={recipeBusy}
                              onChange={event => { setRenameValue(event.target.value) }}
                            />
                            <button
                              type="button"
                              className={styles.browserAgentButton}
                              disabled={recipeBusy}
                              onClick={() => { void submitRename(recipe) }}
                            >
                              {t('browserAgentDemoRecipeRenameSave')}
                            </button>
                            <button
                              type="button"
                              className={styles.browserAgentButton}
                              disabled={recipeBusy}
                              onClick={() => { setRenamingId(null) }}
                            >
                              {t('browserAgentDemoRecipeCancel')}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className={styles.browserAgentRecipeName}
                              aria-expanded={openRecipeId === recipe.id}
                              title={t('browserAgentDemoRecipeDetails')}
                              onClick={() => { void toggleRecipeSteps(recipe) }}
                            >
                              {openRecipeId === recipe.id ? '▾ ' : '▸ '}
                              {recipe.name}
                            </button>
                            <span className={styles.browserAgentRecipeSteps}>
                              {t('browserAgentDemoRecipeStepCount').replace('{n}', String(recipe.steps))}
                            </span>
                            {recipe.pendingHeal === undefined ? null : (
                              <span className={styles.browserAgentRecipeBadge}>
                                {t('browserAgentDemoRecipeHealBadge')}
                              </span>
                            )}
                            {recipe.unattended ? (
                              <span className={styles.browserAgentRecipeBadge}>
                                {t('browserAgentDemoRecipeUnattendedBadge')}
                              </span>
                            ) : null}
                            <button
                              type="button"
                              className={styles.browserAgentButtonPrimary}
                              disabled={recipeBusy}
                              onClick={() => { beginRun(recipe) }}
                            >
                              {t('browserAgentDemoRecipeRun')}
                            </button>
                            <button
                              type="button"
                              className={styles.browserAgentRecipeMore}
                              aria-expanded={menuFor === recipe.id}
                              aria-label={t('browserAgentDemoRecipeMore')}
                              title={t('browserAgentDemoRecipeMore')}
                              disabled={recipeBusy}
                              onClick={() => {
                                setMenuFor(menuFor === recipe.id ? null : recipe.id)
                                setConfirmDeleteId(null)
                              }}
                            >
                              ⋯
                            </button>
                          </>
                        )}
                      </div>
                      {menuFor === recipe.id && renamingId !== recipe.id ? (
                        <div className={styles.browserAgentRecipeMenu} role="group" aria-label={t('browserAgentDemoRecipeMore')}>
                          <button
                            type="button"
                            className={styles.browserAgentRecipeMenuButton}
                            disabled={recipeBusy}
                            onClick={() => { setMenuFor(null); startRename(recipe) }}
                          >
                            {t('browserAgentDemoRecipeRename')}
                          </button>
                          {confirmDeleteId === recipe.id ? (
                            <>
                              <button
                                type="button"
                                className={styles.browserAgentRecipeMenuButton}
                                disabled={recipeBusy}
                                onClick={() => {
                                  setMenuFor(null)
                                  setConfirmDeleteId(null)
                                  void deleteRecipe(recipe)
                                }}
                              >
                                {t('browserAgentDemoRecipeConfirmDelete')}
                              </button>
                              <button
                                type="button"
                                className={styles.browserAgentRecipeMenuButton}
                                disabled={recipeBusy}
                                onClick={() => { setConfirmDeleteId(null) }}
                              >
                                {t('browserAgentDemoRecipeCancel')}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className={styles.browserAgentRecipeMenuButton}
                              disabled={recipeBusy}
                              onClick={() => { setConfirmDeleteId(recipe.id) }}
                            >
                              {t('browserAgentDemoRecipeDelete')}
                            </button>
                          )}
                        </div>
                      ) : null}
                      {recipe.pendingHeal === undefined ? null : (
                        <div className={styles.browserAgentHeal}>
                          <p className={styles.browserAgentHealText}>
                            {t('browserAgentDemoHealText')
                              .replace('{n}', String(recipe.pendingHeal.failedAt))
                              .replace('{label}', recipe.pendingHeal.label)}
                          </p>
                          {recipe.pendingHeal.inserted === 0 ? null : (
                            <p className={styles.browserAgentPaneNote}>
                              {t('browserAgentDemoHealInserted').replace('{n}', String(recipe.pendingHeal.inserted))}
                            </p>
                          )}
                          <div className={styles.browserAgentActions}>
                            <button
                              type="button"
                              className={styles.browserAgentButton}
                              disabled={recipeBusy}
                              onClick={() => { void resolveHeal(recipe, true) }}
                            >
                              {t('browserAgentDemoHealKeep')}
                            </button>
                            <button
                              type="button"
                              className={styles.browserAgentButton}
                              disabled={recipeBusy}
                              onClick={() => { void resolveHeal(recipe, false) }}
                            >
                              {t('browserAgentDemoHealSkip')}
                            </button>
                          </div>
                        </div>
                      )}
                      {varsFor === recipe.id ? (
                        <div className={styles.browserAgentRecipeVars}>
                          {recipe.variables.map(variable => (
                            <label key={variable.name} className={styles.browserAgentRecipeVarRow}>
                              <span className={styles.browserAgentRecipeVarName}>{variable.label}</span>
                              <input
                                className={styles.browserAgentDemoName}
                                type={variable.kind === 'date' ? 'date' : 'text'}
                                placeholder={t('browserAgentDemoRecipeVarHint')}
                                value={varsValues[variable.name] ?? ''}
                                aria-label={variable.label}
                                disabled={recipeBusy}
                                onChange={event => {
                                  const next = event.target.value
                                  setVarsValues(previous => ({ ...previous, [variable.name]: next }))
                                }}
                              />
                            </label>
                          ))}
                          <div className={styles.browserAgentActions}>
                            <button
                              type="button"
                              className={styles.browserAgentButton}
                              disabled={recipeBusy}
                              onClick={() => {
                                setVarsFor(null)
                                void runRecipe(recipe, varsValues)
                              }}
                            >
                              {t('browserAgentDemoRecipeRun')}
                            </button>
                            <button
                              type="button"
                              className={styles.browserAgentButton}
                              disabled={recipeBusy}
                              onClick={() => { setVarsFor(null) }}
                            >
                              {t('browserAgentDemoRecipeCancel')}
                            </button>
                          </div>
                        </div>
                      ) : null}
                      {openRecipeId === recipe.id && recipe.variables.length > 0 ? (
                        <section className={styles.browserAgentRecipeSection}>
                          <span className={styles.browserAgentRecipeSectionTitle}>{t('browserAgentDemoVarsTitle')}</span>
                          <div className={styles.browserAgentRecipeVars}>
                          {recipe.variables.map(variable => (
                            <div
                              key={`${variable.name}:${variable.default}:${variable.ask ? 'ask' : 'fixed'}`}
                              className={styles.browserAgentRecipeVarEditorRow}
                            >
                              <input
                                className={styles.browserAgentRecipeVarLabel}
                                defaultValue={variable.label}
                                aria-label={t('browserAgentDemoVarLabel')}
                                title={t('browserAgentDemoVarLabel')}
                                disabled={recipeBusy}
                                onBlur={event => {
                                  const next = event.target.value.trim()
                                  if (next !== '' && next !== variable.label) {
                                    void updateVariable(recipe, variable.name, { label: next })
                                  }
                                }}
                              />
                              <input
                                className={styles.browserAgentDemoName}
                                type={!variable.ask && variable.kind === 'date' ? 'date' : 'text'}
                                defaultValue={variable.ask ? '' : variable.default}
                                placeholder={variable.ask
                                  ? t('browserAgentDemoVarAskPlaceholder')
                                  : t('browserAgentDemoRecipeVarHint')}
                                aria-label={variable.label}
                                disabled={recipeBusy || variable.ask}
                                onBlur={event => {
                                  const next = event.target.value
                                  if (next !== variable.default) {
                                    void updateVariable(recipe, variable.name, { default: next })
                                  }
                                }}
                              />
                              <label className={styles.browserAgentRecipeVarAsk}>
                                <input
                                  type="checkbox"
                                  checked={variable.ask}
                                  disabled={recipeBusy}
                                  onChange={event => {
                                    void updateVariable(recipe, variable.name, { ask: event.target.checked })
                                  }}
                                />
                                <span>{t('browserAgentDemoVarAskToggle')}</span>
                              </label>
                              <button
                                type="button"
                                className={styles.browserAgentRecipeLink}
                                disabled={recipeBusy}
                                onClick={() => { void removeVariable(recipe, variable.name) }}
                              >
                                {t('browserAgentDemoVarRevert')}
                              </button>
                            </div>
                          ))}
                          </div>
                        </section>
                      ) : null}
                      {openRecipeId === recipe.id ? (
                        <>
                          <section className={styles.browserAgentRecipeSection}>
                            <span className={styles.browserAgentRecipeSectionTitle}>{t('browserAgentDemoRunOptions')}</span>
                            <div className={styles.browserAgentRecipeHistory}>
                              <span className={styles.browserAgentPaneNote}>
                                {recipe.unattended
                                  ? t('browserAgentDemoUnattendedOn').replace('{site}', recipe.site ?? '')
                                  : t('browserAgentDemoUnattendedHint')}
                              </span>
                              <button
                                type="button"
                                className={styles.browserAgentButton}
                                aria-pressed={recipe.unattended}
                                disabled={recipeBusy || recipe.site === undefined}
                                title={recipe.site === undefined ? t('browserAgentDemoUnattendedNoSite') : undefined}
                                onClick={() => { void setUnattended(recipe, !recipe.unattended) }}
                              >
                                {recipe.unattended
                                  ? t('browserAgentDemoUnattendedDisable')
                                  : t('browserAgentDemoUnattendedEnable')}
                              </button>
                            </div>
                            {recipe.history > 0 ? (
                              <div className={styles.browserAgentRecipeHistory}>
                                <span className={styles.browserAgentPaneNote}>
                                  {t('browserAgentDemoRecipeVersion').replace('{n}', String(recipe.rev))}
                                </span>
                                <button
                                  type="button"
                                  className={styles.browserAgentRecipeLink}
                                  disabled={recipeBusy}
                                  onClick={() => { void rollbackRecipe(recipe) }}
                                >
                                  {t('browserAgentDemoRecipeUndo')}
                                </button>
                              </div>
                            ) : null}
                          </section>
                          <section className={styles.browserAgentRecipeSection}>
                            <details className={styles.browserAgentRecipeStepsBox}>
                              <summary className={styles.browserAgentRecipeStepsSummary}>
                                {t('browserAgentDemoStepsShow').replace('{n}', String(recipe.steps))}
                              </summary>
                              <div className={styles.browserAgentRecipeStepList}>
                                {recipeStepRows.length === 0 ? (
                                  <span className={styles.browserAgentPaneNote}>{t('browserAgentDemoEmpty')}</span>
                                ) : recipeStepRows.map(row => (
                                  <div key={row.index} className={styles.browserAgentRecipeStepRow}>
                                    <span className={styles.browserAgentRecipeStepText}>
                                      {row.index + 1}. {row.label}
                                    </span>
                                    {row.canParameterize ? (
                                      <button
                                        type="button"
                                        className={styles.browserAgentButton}
                                        disabled={recipeBusy}
                                        onClick={() => { void parameterizeStep(recipe, row.index) }}
                                      >
                                        {paramBusyIndex === row.index
                                          ? t('browserAgentDemoRecipeVarWorking')
                                          : t('browserAgentDemoRecipeSetVar')}
                                      </button>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            </details>
                          </section>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {demoSteps !== null ? (
              <>
                <pre className={styles.browserAgentDemoSteps}>
                  {demoSteps.length === 0 ? t('browserAgentDemoEmpty') : demoSteps.join('\n')}
                </pre>
                {demoSteps.length > 0 ? (
                  <div className={styles.browserAgentActions}>
                    <button
                      type="button"
                      className={styles.browserAgentButton}
                      disabled={busy}
                      onClick={() => { void copyDemoSteps() }}
                    >
                      {t('browserAgentDemoCopy')}
                    </button>
                    <button
                      type="button"
                      className={styles.browserAgentButton}
                      disabled={busy}
                      onClick={sendDemoSteps}
                    >
                      {t('browserAgentDemoSend')}
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
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

