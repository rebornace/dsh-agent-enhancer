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
  isFollowSessionModel,
  resolveSettings,
} from '../../config.ts'
import type { AuxiliaryFeature, AuxiliaryModelSettings, EnhancerSettings, ModuleName } from '../../config.ts'
import styles from '../styles.module.css'
import {
  decodeModelSelection,
  encodeEffortSelection,
  encodeFollowSelection,
  encodeModelSelection,
} from './model-catalog.ts'

type SettingsForm = Pick<ConfigForm<EnhancerSettings>, 'getSnapshot' | 'subscribe' | 'set'>

export interface PluginSettingsProps {
  readonly form: SettingsForm
  readonly t: TranslateNS<'composer-enhancer'>
  readonly loadCatalog?: () => Promise<ModelCatalog>
}

const LABELS = {
  history: 'history',
  optimize: 'optimize',
  predict: 'predict',
  rollback: 'rollback',
} as const

const DESCRIPTIONS = {
  history: 'historyDescription',
  optimize: 'optimizeDescription',
  predict: 'predictDescription',
  rollback: 'rollbackDescription',
} as const

const MODEL_FEATURES = new Set<ModuleName>(['optimize', 'predict'])

function findModel(
  groups: readonly ModelProviderGroup[],
  provider: string,
  model: string,
): ModelCatalogModel | undefined {
  return groups.find(group => group.id === provider)?.models.find(entry => entry.id === model)
}

function pillLabel(
  selection: AuxiliaryModelSettings,
  groups: readonly ModelProviderGroup[],
  followLabel: string,
): string {
  if (isFollowSessionModel(selection)) return followLabel
  const model = findModel(groups, selection.provider, selection.model)
  const name = model?.name ?? selection.model
  if (selection.reasoningEffort === '') return name
  const effort = model?.reasoning?.efforts.find(entry => entry.id === selection.reasoningEffort)
  return `${name} · ${effort?.name ?? selection.reasoningEffort}`
}

function catalogMenuItems(
  groups: readonly ModelProviderGroup[],
  followLabel: string,
  defaultEffortLabel: string,
): MenuEntry[] {
  const items: MenuEntry[] = [{ id: encodeFollowSelection(), label: followLabel }]
  for (const group of groups) {
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
): string {
  if (isFollowSessionModel(selection)) return encodeFollowSelection()
  const model = findModel(groups, selection.provider, selection.model)
  if ((model?.reasoning?.efforts.length ?? 0) > 0) {
    return encodeEffortSelection(selection.provider, selection.model, selection.reasoningEffort)
  }
  return encodeModelSelection(selection.provider, selection.model)
}

interface ModelPillProps {
  readonly feature: AuxiliaryFeature
  readonly selection: AuxiliaryModelSettings
  readonly groups: readonly ModelProviderGroup[]
  readonly catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  readonly disabled: boolean
  readonly t: TranslateNS<'composer-enhancer'>
  readonly onOpen: () => void
  readonly onSelect: (feature: AuxiliaryFeature, id: string) => void
}

function ModelPill({
  feature,
  selection,
  groups,
  catalogStatus,
  disabled,
  t,
  onOpen,
  onSelect,
}: ModelPillProps) {
  const [open, setOpen] = useState(false)
  const followLabel = t('modelFollowSession')
  const label = catalogStatus === 'loading'
    ? t('modelCatalogLoading')
    : catalogStatus === 'error'
      ? t('modelCatalogError')
      : pillLabel(selection, groups, followLabel)
  const items = catalogMenuItems(groups, followLabel, t('reasoningDefault'))
  const active = !isFollowSessionModel(selection)

  return <Menu
    open={open}
    onClose={() => { setOpen(false) }}
    align="end"
    side="bottom"
    portal
    compact
    dense
    selectedId={selectedMenuId(selection, groups)}
    items={catalogStatus === 'ready' ? items : [{ id: encodeFollowSelection(), label: followLabel }]}
    onSelect={id => {
      setOpen(false)
      onSelect(feature, id)
    }}
    anchor={<Pill
      active={active || open}
      disabled={disabled}
      className={styles.modelPill}
      aria-label={`${t(LABELS[feature])} ${t('modelLabel')}`}
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
    console.error('composer-enhancer settings render failed', error, info.componentStack)
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
    await saveFields([
      [`${feature}Provider`, decoded.provider],
      [`${feature}Model`, decoded.model],
      [`${feature}ReasoningEffort`, decoded.reasoningEffort],
    ])
  }

  const busy = !writable || saving !== null
  const groups = catalog?.groups ?? []

  return <section aria-label={t('settingsTitle')} className={styles.settings}>
    <header className={styles.settingsHeader}>
      <h2>{t('settingsTitle')}</h2>
      <p>{t('settingsSubtitle')}</p>
    </header>
    {MODULES.map(module => {
      const modelFeature = MODEL_FEATURES.has(module) ? module as AuxiliaryFeature : null
      const selection = modelFeature === null ? null : auxiliaryModelOf(settings, modelFeature)
      return <div key={module} className={styles.settingRow}>
        <div className={styles.settingText}>
          <h3>{t(LABELS[module])}</h3>
          <p className={styles.settingDescription}>{t(DESCRIPTIONS[module])}</p>
        </div>
        <div className={styles.settingControls}>
          {modelFeature !== null && selection !== null && (
            <ModelPill
              feature={modelFeature}
              selection={selection}
              groups={groups}
              catalogStatus={catalogStatus}
              disabled={busy}
              t={t}
              onOpen={refreshCatalog}
              onSelect={(feature, id) => { void onModelMenuSelect(feature, id) }}
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
