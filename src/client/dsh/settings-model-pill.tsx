import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import { Menu, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { isAutoModel, isFollowSessionModel } from '../../config.ts'
import type { AuxiliaryModelSettings, EnhancerSettings } from '../../config.ts'
import styles from '../styles.module.css'
import {
  encodeAutoSelection,
  encodeEffortSelection,
  encodeFollowSelection,
  encodeModelSelection,
  encodeUnconfiguredSelection,
} from './model-catalog.ts'
import { pillLabel, isUnconfiguredAutoTierMapping, selectedPillMenuId } from './model-pill-label.ts'
import type { AutoRouteTier } from './settings-catalog.ts'

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
  unconfiguredLabel?: string,
): MenuEntry[] {
  const items: MenuEntry[] = []
  if (includeSessionOptions) {
    items.push({ id: encodeFollowSelection(), label: followLabel })
    items.push({ id: encodeAutoSelection(), label: autoLabel })
  } else if (unconfiguredLabel !== undefined) {
    items.push({ id: encodeUnconfiguredSelection(), label: unconfiguredLabel })
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

export interface ModelPillProps {
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

export function ModelPill({
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
    unconfiguredLabel,
  )
  const tierMapping = !includeSessionOptions
  const active = tierMapping
    ? !isUnconfiguredAutoTierMapping(selection) && !isFollowSessionModel(selection)
    : !isFollowSessionModel(selection)
  const catalogFallbackItems: MenuEntry[] = includeSessionOptions
    ? [{ id: encodeFollowSelection(), label: followLabel }, { id: encodeAutoSelection(), label: autoLabel }]
    : [{ id: encodeUnconfiguredSelection(), label: unconfiguredLabel ?? t('modelUnconfigured') }]

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

export function autoTierSelection(settings: EnhancerSettings, tier: AutoRouteTier): AuxiliaryModelSettings {
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

export function autoTierFieldPrefix(tier: AutoRouteTier): 'autoInstant' | 'autoThinking' | 'autoPro' | 'autoClassifier' {
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
