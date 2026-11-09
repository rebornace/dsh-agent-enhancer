import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { Component, useEffect, useState, useSyncExternalStore } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { resolveSettings } from '../../config.ts'
import type {
  BrowserAgentBrowser,
  ConfigurableAuxiliaryFeature,
  EnhancerSettings,
  ModuleName,
  RunAlertsLevel,
} from '../../config.ts'
import type { ApplyUpdateResult, UpdateCheckResult } from '../../host/update/types.ts'
import { AUTO_MODEL, AUTO_PROVIDER } from '../../host/auto-route/sentinel.ts'
import styles from '../styles.module.css'
import { decodeModelSelection } from './model-catalog.ts'
import type { SettingsPersistOp } from './persist-settings.ts'
import { SettingsAboutPanel } from './settings-about.tsx'
import { SETTINGS_TABS } from './settings-catalog.ts'
import type { AutoRouteTier, SettingsTabId } from './settings-catalog.ts'
import { SettingsFeaturesPanel } from './settings-features.tsx'
import {
  skillsLeftNavPanellistSupported,
  subscribeSkillsLeftNavPanellist,
} from '../instructions-skills/left-nav.ts'
import {
  mcpConnectorsLeftNavPanellistSupported,
  subscribeMcpConnectorsLeftNavPanellist,
} from '../mcp-connectors/left-nav.ts'
import {
  subscribeWebChatBridgeLeftNavPanellist,
  webChatBridgeLeftNavPanellistSupported,
} from '../web-chat-bridge/left-nav.ts'
import { SettingsModelsPanel } from './settings-models.tsx'
import { autoTierFieldPrefix } from './settings-model-pill.tsx'
import { agentEnhancerBrowserAgentSetBrowser } from '../remote.ts'

type SettingsForm = Pick<ConfigForm<EnhancerSettings>, 'getSnapshot' | 'subscribe' | 'set' | 'mutate'>

export interface PluginSettingsProps {
  readonly form: SettingsForm
  readonly t: TranslateNS<'agent-enhancer'>
  /** Fence-free Host write; preferred over form.mutate/set for Desktop 0.2.2. */
  readonly persist?: (ops: readonly SettingsPersistOp[]) => Promise<void>
  readonly loadCatalog?: () => Promise<ModelCatalog>
  readonly checkUpdate?: () => Promise<UpdateCheckResult>
  readonly applyUpdate?: () => Promise<ApplyUpdateResult>
  /** Host remote — sync browser preference live so Agent tools honor Settings without Launch. */
  readonly getRemote?: () => unknown
}

class SettingsErrorBoundary extends Component<
  { readonly children: ReactNode; readonly fallback: (error: Error) => ReactNode },
  { readonly error: Error | null }
> {
  state: { readonly error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { readonly error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('agent-enhancer settings render failed', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error !== null) return this.props.fallback(this.state.error)
    return this.props.children
  }
}

function tabLabel(
  tab: SettingsTabId,
  t: TranslateNS<'agent-enhancer'>,
): string {
  switch (tab) {
    case 'features':
      return t('settingsTabFeatures')
    case 'models':
      return t('settingsTabModels')
    case 'about':
      return t('settingsTabAbout')
    default: {
      const _exhaustive: never = tab
      return _exhaustive
    }
  }
}

function PluginSettingsBody({ form, t, persist, loadCatalog, checkUpdate, applyUpdate, getRemote }: PluginSettingsProps) {
  const formState = useSyncExternalStore(
    listener => form.subscribe(listener),
    () => form.getSnapshot(),
    () => form.getSnapshot(),
  )
  const settings = resolveSettings(formState?.value)
  const skillsLeftNavSeatReady = useSyncExternalStore(
    subscribeSkillsLeftNavPanellist,
    skillsLeftNavPanellistSupported,
    () => false,
  )
  const mcpConnectorsLeftNavSeatReady = useSyncExternalStore(
    subscribeMcpConnectorsLeftNavPanellist,
    mcpConnectorsLeftNavPanellistSupported,
    () => false,
  )
  const webChatBridgeLeftNavSeatReady = useSyncExternalStore(
    subscribeWebChatBridgeLeftNavPanellist,
    webChatBridgeLeftNavPanellistSupported,
    () => false,
  )
  const writable = formState?.writable !== false
  const [tab, setTab] = useState<SettingsTabId>('features')
  const [highlightFeature, setHighlightFeature] = useState<ConfigurableAuxiliaryFeature | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [saveDetail, setSaveDetail] = useState<string | null>(null)

  const writeOps = async (ops: readonly SettingsPersistOp[]) => {
    if (persist !== undefined) {
      await persist(ops)
      return
    }
    const accepted = await form.mutate(ops as never)
    if (!accepted) {
      const status = form.getSnapshot().status
      if (status === 'unavailable' || status === 'loading') {
        throw new Error(t('settingsUnavailable'))
      }
      throw new Error(t('settingsError'))
    }
  }
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [catalogStatus, setCatalogStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    loadCatalog === undefined ? 'idle' : 'loading',
  )
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const refreshCatalog = () => {
    if (loadCatalog === undefined) return
    setCatalogStatus(current => current === 'ready' ? current : 'loading')
    setCatalogError(null)
    void loadCatalog().then(
      value => {
        setCatalog(value)
        setCatalogStatus('ready')
        setCatalogError(null)
      },
      (cause: unknown) => {
        setCatalog(null)
        setCatalogStatus('error')
        setCatalogError(cause instanceof Error ? cause.message : String(cause))
      },
    )
  }

  useEffect(() => {
    if (loadCatalog === undefined) return
    let active = true
    setCatalogStatus('loading')
    setCatalogError(null)
    void loadCatalog().then(
      value => {
        if (!active) return
        setCatalog(value)
        setCatalogStatus('ready')
        setCatalogError(null)
      },
      (cause: unknown) => {
        if (!active) return
        setCatalog(null)
        setCatalogStatus('error')
        setCatalogError(cause instanceof Error ? cause.message : String(cause))
      },
    )
    return () => { active = false }
  }, [loadCatalog])

  useEffect(() => {
    if (tab !== 'models') setHighlightFeature(null)
  }, [tab])

  const onToggle = async (module: ModuleName, checked: boolean) => {
    setSaving(`${module}Enabled`)
    setError(false)
    setSaveDetail(null)
    try {
      await writeOps([{ op: 'set', path: [`${module}Enabled`], value: checked }])
    } catch (cause) {
      setError(true)
      setSaveDetail(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(null)
    }
  }

  const onRunAlertsLevel = async (level: RunAlertsLevel) => {
    setSaving('runAlertsLevel')
    setError(false)
    setSaveDetail(null)
    try {
      await writeOps([{ op: 'set', path: ['runAlertsLevel'], value: level }])
    } catch (cause) {
      setError(true)
      setSaveDetail(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(null)
    }
  }

  const onBrowserAgentBrowser = async (browser: BrowserAgentBrowser) => {
    setSaving('browserAgentBrowser')
    setError(false)
    setSaveDetail(null)
    try {
      // Live host sync first — Agent tools must see Chrome↔Edge immediately.
      if (getRemote !== undefined) {
        await agentEnhancerBrowserAgentSetBrowser.invoke(getRemote(), { browser })
      }
      await writeOps([{ op: 'set', path: ['browserAgentBrowser'], value: browser }])
    } catch (cause) {
      setError(true)
      setSaveDetail(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(null)
    }
  }

  const saveFields = async (fields: ReadonlyArray<readonly [keyof EnhancerSettings, string]>) => {
    setSaving(fields.map(([field]) => field).join(','))
    setError(false)
    setSaveDetail(null)
    try {
      await writeOps(fields.map(([field, value]) => ({
        op: 'set' as const,
        path: [field],
        value,
      })))
    } catch (cause) {
      setError(true)
      setSaveDetail(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(null)
    }
  }

  const onModelMenuSelect = async (feature: ConfigurableAuxiliaryFeature, id: string) => {
    const decoded = decodeModelSelection(id)
    if (decoded === null) return
    switch (decoded.kind) {
      case 'follow':
        await saveFields([
          [`${feature}Provider`, ''],
          [`${feature}Model`, ''],
          [`${feature}ReasoningEffort`, ''],
        ])
        return
      case 'auto':
        await saveFields([
          [`${feature}Provider`, AUTO_PROVIDER],
          [`${feature}Model`, AUTO_MODEL],
          [`${feature}ReasoningEffort`, ''],
        ])
        return
      case 'unconfigured':
        return
      case 'model':
        await saveFields([
          [`${feature}Provider`, decoded.provider],
          [`${feature}Model`, decoded.model],
          [`${feature}ReasoningEffort`, decoded.reasoningEffort],
        ])
        return
      default: {
        const _exhaustive: never = decoded
        return _exhaustive
      }
    }
  }

  const onAutoTierMenuSelect = async (tier: AutoRouteTier, id: string) => {
    const decoded = decodeModelSelection(id)
    if (decoded === null) return
    const prefix = autoTierFieldPrefix(tier)
    switch (decoded.kind) {
      case 'unconfigured':
        await saveFields([
          [`${prefix}Provider`, ''],
          [`${prefix}Model`, ''],
          [`${prefix}ReasoningEffort`, ''],
        ])
        return
      case 'model':
        await saveFields([
          [`${prefix}Provider`, decoded.provider],
          [`${prefix}Model`, decoded.model],
          [`${prefix}ReasoningEffort`, decoded.reasoningEffort],
        ])
        return
      case 'follow':
      case 'auto':
        return
      default: {
        const _exhaustive: never = decoded
        return _exhaustive
      }
    }
  }

  const onClassifierToggle = async (checked: boolean) => {
    setSaving('autoClassifierEnabled')
    setError(false)
    setSaveDetail(null)
    try {
      await writeOps([{ op: 'set', path: ['autoClassifierEnabled'], value: checked }])
    } catch (cause) {
      setError(true)
      setSaveDetail(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(null)
    }
  }

  const busy = !writable || saving !== null
  const groups = catalog?.groups ?? []

  const statusBlock = <>
    {error && <p role="status" className={styles.settingsStatus}>{t('settingsError')}</p>}
    {saveDetail !== null && <p role="status" className={styles.settingsStatus}>{saveDetail}</p>}
    {formState?.status === 'unavailable' && !error && (
      <p role="status" className={styles.settingsStatus}>{t('settingsUnavailable')}</p>
    )}
    {catalogStatus === 'error' && catalogError !== null && (
      <p role="status" className={styles.settingsStatus} title={catalogError}>
        {t('modelCatalogError')}: {catalogError}
      </p>
    )}
  </>

  let panel: ReactNode
  switch (tab) {
    case 'features':
      panel = (
        <SettingsFeaturesPanel
          settings={settings}
          busy={busy}
          t={t}
          onToggle={(module, checked) => { void onToggle(module, checked) }}
          onRunAlertsLevel={level => { void onRunAlertsLevel(level) }}
          onBrowserAgentBrowser={browser => { void onBrowserAgentBrowser(browser) }}
          onOpenModel={feature => {
            setHighlightFeature(feature)
            setTab('models')
          }}
          featureExtraDescription={module => {
            if (module === 'instructionsSkills') {
              if (!settings.instructionsSkillsEnabled || skillsLeftNavSeatReady) return undefined
              return t('instructionsSkillsLeftNavUnsupported')
            }
            if (module === 'mcpConnectors') {
              if (!settings.mcpConnectorsEnabled || mcpConnectorsLeftNavSeatReady) return undefined
              return t('mcpConnectorsLeftNavUnsupported')
            }
            if (module === 'webChatBridge') {
              if (!settings.webChatBridgeEnabled || webChatBridgeLeftNavSeatReady) return undefined
              return t('webChatLeftNavUnsupported')
            }
            return undefined
          }}
        />
      )
      break
    case 'models':
      panel = (
        <SettingsModelsPanel
          settings={settings}
          groups={groups}
          catalogStatus={catalogStatus}
          busy={busy}
          t={t}
          highlightFeature={highlightFeature}
          onRefreshCatalog={refreshCatalog}
          onModelSelect={(feature, id) => { void onModelMenuSelect(feature, id) }}
          onAutoTierSelect={(tier, id) => { void onAutoTierMenuSelect(tier, id) }}
          onClassifierToggle={checked => { void onClassifierToggle(checked) }}
        />
      )
      break
    case 'about':
      panel = (
        <SettingsAboutPanel
          t={t}
          checkUpdate={checkUpdate}
          applyUpdate={applyUpdate}
        />
      )
      break
    default: {
      const _exhaustive: never = tab
      return _exhaustive
    }
  }

  return (
    <section aria-label={t('settingsTitle')} className={styles.settings}>
      <header className={styles.settingsHeader}>
        <h2 className={styles.settingsHeading}>{t('settingsTitle')}</h2>
        <p className={styles.settingsIntro}>{t('settingsSubtitle')}</p>
      </header>
      <div className={styles.settingsTabs} role="tablist" aria-label={t('settingsTitle')}>
        {SETTINGS_TABS.map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            className={styles.settingsTab}
            data-active={tab === id ? 'true' : undefined}
            aria-selected={tab === id}
            onClick={() => { setTab(id) }}
          >
            {tabLabel(id, t)}
          </button>
        ))}
      </div>
      <div className={styles.settingsTabPanel} role="tabpanel">
        {panel}
        {statusBlock}
      </div>
    </section>
  )
}

export function PluginSettings(props: PluginSettingsProps) {
  return <SettingsErrorBoundary fallback={error => (
    <section className={styles.settings} role="alert">
      <h2 className={styles.settingsHeading}>{props.t('settingsTitle')}</h2>
      <p className={styles.settingDescription}>{props.t('settingsError')}</p>
      <pre className={styles.settingDescription}>{error.message}</pre>
    </section>
  )}>
    <PluginSettingsBody {...props} />
  </SettingsErrorBoundary>
}
