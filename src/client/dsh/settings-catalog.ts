import type { ConfigurableAuxiliaryFeature, ModuleName } from '../../config.ts'

/** In-plugin settings tabs — mirrors official plugins underline chrome. */
export const SETTINGS_TABS = ['features', 'models', 'about'] as const
export type SettingsTabId = typeof SETTINGS_TABS[number]

export type SettingsGroupId = 'chat' | 'workspace'

export type FeatureLabelKey =
  | 'history'
  | 'optimize'
  | 'predict'
  | 'rollback'
  | 'contextInspect'
  | 'sessionDelete'
  | 'fileEdit'

export type FeatureDescriptionKey =
  | 'historyDescription'
  | 'optimizeDescription'
  | 'predictDescription'
  | 'rollbackDescription'
  | 'contextInspectDescription'
  | 'sessionDeleteDescription'
  | 'fileEditDescription'

export interface SettingsFeatureEntry {
  readonly module: ModuleName
  readonly labelKey: FeatureLabelKey
  readonly descriptionKey: FeatureDescriptionKey
  readonly modelFeature: ConfigurableAuxiliaryFeature | null
}

export interface SettingsFeatureGroup {
  readonly id: SettingsGroupId
  readonly titleKey: 'settingsGroupChat' | 'settingsGroupWorkspace'
  readonly entries: readonly SettingsFeatureEntry[]
}

/** Append new modules here — features tab renders from this table. */
export const SETTINGS_FEATURE_GROUPS: readonly SettingsFeatureGroup[] = [
  {
    id: 'chat',
    titleKey: 'settingsGroupChat',
    entries: [
      {
        module: 'history',
        labelKey: 'history',
        descriptionKey: 'historyDescription',
        modelFeature: null,
      },
      {
        module: 'optimize',
        labelKey: 'optimize',
        descriptionKey: 'optimizeDescription',
        modelFeature: 'optimize',
      },
      {
        module: 'predict',
        labelKey: 'predict',
        descriptionKey: 'predictDescription',
        modelFeature: 'predict',
      },
      {
        module: 'rollback',
        labelKey: 'rollback',
        descriptionKey: 'rollbackDescription',
        modelFeature: null,
      },
      {
        module: 'contextInspect',
        labelKey: 'contextInspect',
        descriptionKey: 'contextInspectDescription',
        modelFeature: 'compact',
      },
    ],
  },
  {
    id: 'workspace',
    titleKey: 'settingsGroupWorkspace',
    entries: [
      {
        module: 'sessionDelete',
        labelKey: 'sessionDelete',
        descriptionKey: 'sessionDeleteDescription',
        modelFeature: null,
      },
      {
        module: 'fileEdit',
        labelKey: 'fileEdit',
        descriptionKey: 'fileEditDescription',
        modelFeature: null,
      },
    ],
  },
]

export type AutoRouteTier = 'instant' | 'thinking' | 'pro' | 'classifier'

export const AUTO_TIERS: readonly AutoRouteTier[] = ['instant', 'thinking', 'pro', 'classifier']

export const AUTO_TIER_LABELS: Record<
  AutoRouteTier,
  'autoTier_instant' | 'autoTier_thinking' | 'autoTier_pro' | 'autoTier_classifier'
> = {
  instant: 'autoTier_instant',
  thinking: 'autoTier_thinking',
  pro: 'autoTier_pro',
  classifier: 'autoTier_classifier',
}

export const MODEL_FEATURE_ROWS: readonly {
  readonly feature: ConfigurableAuxiliaryFeature
  readonly titleKey: 'optimize' | 'predict' | 'contextInspect'
  readonly enabledModule: ModuleName
}[] = [
  { feature: 'optimize', titleKey: 'optimize', enabledModule: 'optimize' },
  { feature: 'predict', titleKey: 'predict', enabledModule: 'predict' },
  { feature: 'compact', titleKey: 'contextInspect', enabledModule: 'contextInspect' },
]
