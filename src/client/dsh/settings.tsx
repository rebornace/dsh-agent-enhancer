import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelCatalog, ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import { Menu, Pill, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { Component, useEffect, useState, useSyncExternalStore } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import {
  MODULES,
  auxiliaryModelOf,
  isAutoModel,
  isFollowSessionModel,
  resolveSettings,
} from '../../config.ts'
import type { AuxiliaryFeature, AuxiliaryModelSettings, EnhancerSettings, ModuleName } from '../../config.ts'
import { AUTO_MODEL, AUTO_PROVIDER } from '../../host/auto-route/sentinel.ts'
import styles from '../styles.module.css'
import {
  decodeModelSelection,
  encodeAutoSelection,
  encodeEffortSelection,
  encodeFollowSelection,
  encodeModelSelection,
} from './model-catalog.ts'
import { pillLabel, isUnconfiguredAutoTierMapping, selectedPillMenuId } from './model-pill-label.ts'

type AutoRouteTier = 'instant' | 'thinking' | 'pro' | 'classifier'

const AUTO_TIER_LABELS: Record<AutoRouteTier, 'autoTier_instant' | 'autoTier_thinking' | 'autoTier_pro' | 'autoTier_classifier'> = {
  instant: 'autoTier_instant',
  thinking: 'autoTier_thinking',
  pro: 'autoTier_pro',
  classifier: 'autoTier_classifier',
}

function autoTierSelection(settings: EnhancerSettings, tier: AutoRouteTier): AuxiliaryModelSettings {
  switch (tier) {
    case 'instant':
      return {
        provider: settings.autoInstantProvider,
        model: settings.autoInstantModel,
        reasoningEffort: settings.autoInstantReasoningEffort,
      }
    case 'thinking':
      return {
        provider: settings.autoThinkingProvider,
        model: settings.autoThinkingModel,
        reasoningEffort: settings.autoThinkingReasoningEffort,
      }
    case 'pro':
      return {
        provider: settings.autoProProvider,
        model: settings.autoProModel,
        reasoningEffort: settings.autoProReasoningEffort,
      }
    case 'classifier':
      return {
        provider: settings.autoClassifierProvider,
        model: settings.autoClassifierModel,
        reasoningEffort: settings.autoClassifierReasoningEffort,
      }
    default: {
      const _exhaustive: never = tier
      return _exhaustive
    }
  }
}

function autoTierFieldPrefix(tier: AutoRouteTier): 'autoInstant' | 'autoThinking' | 'autoPro' | 'autoClassifier' {
  switch (tier) {
    case 'instant':
      return 'autoInstant'
    case 'thinking':
      return 'autoThinking'
    case 'pro':
      return 'autoPro'
    case 'classifier':
      return 'autoClassifier'
    default: {
      const _exhaustive: never = tier
      return _exhaustive
    }
  }
}

type SettingsForm = Pick<ConfigForm<EnhancerSettings>, 'getSnapshot' | 'subscribe' | 'set'>

export interface PluginSettingsProps {
  readonly form: SettingsForm
  readonly t: TranslateNS<'agent-enhancer'>
  readonly loadCatalog?: () => Promise<ModelCatalog>
}

const LABELS = {
  history: 'history',
  optimize: 'optimize',
  predict: 'predict',
  rollback: 'rollback',
  contextInspect: 'contextInspect',
} as const

const DESCRIPTIONS = {
  history: 'historyDescription',
  optimize: 'optimizeDescription',
  predict: 'predictDescription',
  rollback: 'rollbackDescription',
  contextInspect: 'contextInspectDescription',
} as const

function modelFeatureOf(module: ModuleName): AuxiliaryFeature | null {
  switch (module) {
    case 'optimize':
      return 'optimize'
    case 'predict':
      return 'predict'
    case 'contextInspect':
      return 'compact'
    case 'history':
    case 'rollback':
      return null
    default: {
      const _exhaustive: never = module
      return _exhaustive
    }
  }
}

/**
 * Official `/model` lists Auto through the host sentinel adapter
 * (`installAutoSessionRoute`). These pills already have their own Auto row,
 * so the catalog copy of that sentinel is hidden here.
 */
function groupsForPills(groups: readonly ModelProviderGroup[]): readonly ModelProviderGroup[] {
  return groups.flatMap(group => {
    const models = group.models.filter(model => !isAutoModel({ provider: group.id, model: model.id }))
    if (models.length === 0) return []
    if (models.length === group.models.length) return [group]
    return [{ ...group, models }]
  })
}

function catalogMenuItems(
  groups: readonly ModelProviderGroup[],
  followLabel: string,
  autoLabel: string,
  defaultEffortLabel: string,
  includeSessionOptions: boolean,
): MenuEntry[] {
  const items: MenuEntry[] = []
  if (includeSessionOptions) {
    items.push({ id: encodeFollowSelection(), label: followLabel })
    items.push({ id: encodeAutoSelection(), label: autoLabel })
  }
  for (const group of groupsForPills(groups)) {
    items.push({ type: 'separator', id: `sep:${group.id}` })
    items.push({ type: 'label', id: `label:${group.id}`, text: group.name })
    for (const model of group.models) {
      const efforts = model.reasoning?.efforts ?? []
      if (efforts.length === 0) {
        items.push({
          id: encodeModelSelection(group.id, model.id),
          label: model.name,
        })
        continue
      }
      items.push({
        id: encodeEffortSelection(group.id, model.id, ''),
        label: `${model.name} · ${defaultEffortLabel}`,
      })
      for (const effort of efforts) {
        items.push({
          id: encodeEffortSelection(group.id, model.id, effort.id),
          label: `${model.name} · ${effort.name}`,
        })
      }
    }
  }
  return items
}

function selectedMenuId(
  selection: AuxiliaryModelSettings,
  groups: readonly ModelProviderGroup[],
  tierMapping: boolean,
): string {
  return selectedPillMenuId(selection, groups, { tierMapping })
}

interface ModelPillProps {
  readonly selection: AuxiliaryModelSettings
  readonly groups: readonly ModelProviderGroup[]
  readonly catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  readonly disabled: boolean
  readonly t: TranslateNS<'agent-enhancer'>
  readonly ariaLabel: string
  readonly includeSessionOptions: boolean
  readonly onOpen: () => void
  readonly onSelect: (id: string) => void
}

function ModelPill({
  selection,
  groups,
  catalogStatus,
  disabled,
  t,
  ariaLabel,
  includeSessionOptions,
  onOpen,
  onSelect,
}: ModelPillProps) {
  const [open, setOpen] = useState(false)
  const followLabel = t('modelFollowSession')
  const autoLabel = t('modelAuto')
  const unconfiguredLabel = includeSessionOptions ? undefined : t('modelUnconfigured')
  const label = catalogStatus === 'loading'
    ? t('modelCatalogLoading')
    : catalogStatus === 'error'
      ? t('modelCatalogError')
      : pillLabel(selection, groups, followLabel, autoLabel, unconfiguredLabel)
  const items = catalogMenuItems(
    groups,
    followLabel,
    autoLabel,
    t('reasoningDefault'),
    includeSessionOptions,
  )
  const tierMapping = !includeSessionOptions
  const active = tierMapping
    ? !isUnconfiguredAutoTierMapping(selection) && !isFollowSessionModel(selection)
    : !isFollowSessionModel(selection)
  const catalogFallbackItems: MenuEntry[] = includeSessionOptions
    ? [{ id: encodeFollowSelection(), label: followLabel }, { id: encodeAutoSelection(), label: autoLabel }]
    : [{ id: 'tier:unconfigured', label: unconfiguredLabel ?? t('modelUnconfigured') }]

  return <Menu
    open={open}
    onClose={() => { setOpen(false) }}
    align="end"
    side="bottom"
    portal
    compact
    dense
    selectedId={selectedMenuId(selection, groups, tierMapping)}
    items={catalogStatus === 'ready'
      ? items
      : catalogFallbackItems}
    onSelect={id => {
      setOpen(false)
      onSelect(id)
    }}
    anchor={<Pill
      active={active || open}
      disabled={disabled}
      className={styles.modelPill}
      aria-label={ariaLabel}
      title={label}
      onClick={() => {
        if (disabled) return
        onOpen()
        setOpen(current => !current)
      }}
    >
      <span className={styles.modelPillLabel}>{label}</span>
    </Pill>}
  />
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

function PluginSettingsBody({ form, t, loadCatalog }: PluginSettingsProps) {
  const formState = useSyncExternalStore(
    listener => form.subscribe(listener),
    () => form.getSnapshot(),
    () => form.getSnapshot(),
  )
  const settings = resolveSettings(formState?.value)
  const writable = formState?.writable !== false
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState(false)
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

  const onToggle = async (module: ModuleName, checked: boolean) => {
    setSaving(`${module}Enabled`)
    setError(false)
    try {
      const accepted = await form.set(`${module}Enabled`, checked)
      if (!accepted) setError(true)
    } catch {
      setError(true)
    } finally {
      setSaving(null)
    }
  }

  const saveFields = async (fields: ReadonlyArray<readonly [keyof EnhancerSettings, string]>) => {
    setSaving(fields.map(([field]) => field).join(','))
    setError(false)
    try {
      for (const [field, value] of fields) {
        const accepted = await form.set(field, value)
        if (!accepted) {
          setError(true)
          return
        }
      }
    } catch {
      setError(true)
    } finally {
      setSaving(null)
    }
  }

  const onModelMenuSelect = async (feature: AuxiliaryFeature, id: string) => {
    const decoded = decodeModelSelection(id)
    if (decoded === null) return
    if (decoded.kind === 'follow') {
      await saveFields([
        [`${feature}Provider`, ''],
        [`${feature}Model`, ''],
        [`${feature}ReasoningEffort`, ''],
      ])
      return
    }
    if (decoded.kind === 'auto') {
      await saveFields([
        [`${feature}Provider`, AUTO_PROVIDER],
        [`${feature}Model`, AUTO_MODEL],
        [`${feature}ReasoningEffort`, ''],
      ])
      return
    }
    await saveFields([
      [`${feature}Provider`, decoded.provider],
      [`${feature}Model`, decoded.model],
      [`${feature}ReasoningEffort`, decoded.reasoningEffort],
    ])
  }

  const onAutoTierMenuSelect = async (tier: AutoRouteTier, id: string) => {
    const decoded = decodeModelSelection(id)
    if (decoded === null || decoded.kind !== 'model') return
    const prefix = autoTierFieldPrefix(tier)
    await saveFields([
      [`${prefix}Provider`, decoded.provider],
      [`${prefix}Model`, decoded.model],
      [`${prefix}ReasoningEffort`, decoded.reasoningEffort],
    ])
  }

  const onClassifierToggle = async (checked: boolean) => {
    setSaving('autoClassifierEnabled')
    setError(false)
    try {
      const accepted = await form.set('autoClassifierEnabled', checked)
      if (!accepted) setError(true)
    } catch {
      setError(true)
    } finally {
      setSaving(null)
    }
  }

  const autoTiers: readonly AutoRouteTier[] = ['instant', 'thinking', 'pro', 'classifier']

  const busy = !writable || saving !== null
  const groups = catalog?.groups ?? []

  return <section aria-label={t('settingsTitle')} className={styles.settings}>
    <header className={styles.settingsHeader}>
      <h2>{t('settingsTitle')}</h2>
      <p>{t('settingsSubtitle')}</p>
    </header>
    {MODULES.map(module => {
      const modelFeature = modelFeatureOf(module)
      const selection = modelFeature === null ? null : auxiliaryModelOf(settings, modelFeature)
      return <div key={module} className={styles.settingRow}>
        <div className={styles.settingText}>
          <h3>{t(LABELS[module])}</h3>
          <p className={styles.settingDescription}>{t(DESCRIPTIONS[module])}</p>
        </div>
        <div className={styles.settingControls}>
          {modelFeature !== null && selection !== null && (
            <ModelPill
              selection={selection}
              groups={groups}
              catalogStatus={catalogStatus}
              disabled={busy || (module === 'contextInspect' && !settings.contextInspectEnabled)}
              t={t}
              ariaLabel={`${t(modelFeature === 'compact' ? 'contextInspectCompact' : LABELS[modelFeature])} ${t('modelLabel')}`}
              includeSessionOptions
              onOpen={refreshCatalog}
              onSelect={id => { void onModelMenuSelect(modelFeature, id) }}
            />
          )}
          <Switch
            label={t(LABELS[module])}
            checked={settings[`${module}Enabled`]}
            disabled={busy}
            onChange={checked => { void onToggle(module, checked) }}
          />
        </div>
      </div>
    })}

    <div className={styles.settingRow}>
      <div className={styles.settingText}>
        <h3>{t('autoClassifier')}</h3>
        <p className={styles.settingDescription}>{t('autoClassifierDescription')}</p>
      </div>
      <div className={styles.settingControls}>
        <Switch
          label={t('autoClassifier')}
          checked={settings.autoClassifierEnabled}
          disabled={busy}
          onChange={checked => { void onClassifierToggle(checked) }}
        />
      </div>
    </div>

    <div aria-label={t('autoMappingTitle')} className={styles.autoMappingSection}>
      <h3>{t('autoMappingTitle')}</h3>
      {autoTiers.map(tier => {
        const tierSelection = autoTierSelection(settings, tier)
        return <div key={tier} className={styles.settingRow}>
          <div className={styles.settingText}>
            <h3>{t(AUTO_TIER_LABELS[tier])}</h3>
          </div>
          <div className={styles.settingControls}>
            <ModelPill
              selection={tierSelection}
              groups={groups}
              catalogStatus={catalogStatus}
              disabled={busy}
              t={t}
              ariaLabel={`${t(AUTO_TIER_LABELS[tier])} ${t('modelLabel')}`}
              includeSessionOptions={false}
              onOpen={refreshCatalog}
              onSelect={id => { void onAutoTierMenuSelect(tier, id) }}
            />
          </div>
        </div>
      })}
    </div>

    {error && <p role="status">{t('settingsError')}</p>}
    {catalogStatus === 'error' && catalogError !== null && (
      <p role="status" className={styles.settingDescription} title={catalogError}>
        {t('modelCatalogError')}: {catalogError}
      </p>
    )}
    <aside aria-label={t('privacyTitle')} className={styles.privacy}>
      <h3>{t('privacyTitle')}</h3>
      <p>{t('privacy')}</p>
      <p>{t('rollbackBoundary')}</p>
      <p>{t('coexistence')}</p>
    </aside>
  </section>
}

export function PluginSettings(props: PluginSettingsProps) {
  return <SettingsErrorBoundary fallback={error => (
    <section className={styles.settings} role="alert">
      <h2>{props.t('settingsTitle')}</h2>
      <p className={styles.settingDescription}>{props.t('settingsError')}</p>
      <pre className={styles.settingDescription}>{error.message}</pre>
    </section>
  )}>
    <PluginSettingsBody {...props} />
  </SettingsErrorBoundary>
}
