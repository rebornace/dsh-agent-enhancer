import { AUTO_MODEL, AUTO_PROVIDER } from './host/auto-route/sentinel.ts'
import type { AutoRouteMap } from './host/auto-route/types.ts'

export const MODULES = ['history', 'optimize', 'predict', 'rollback', 'contextInspect'] as const
export type ModuleName = typeof MODULES[number]

export type AuxiliaryFeature = 'optimize' | 'predict' | 'compact'

/** Empty provider/model means “follow the current session model”. */
export interface AuxiliaryModelSettings {
  readonly provider: string
  readonly model: string
  /** Empty means adapter default / first advertised effort. */
  readonly reasoningEffort: string
}

export type EnhancerSettings = Readonly<Record<`${ModuleName}Enabled`, boolean>> & {
  readonly optimizeProvider: string
  readonly optimizeModel: string
  readonly optimizeReasoningEffort: string
  readonly predictProvider: string
  readonly predictModel: string
  readonly predictReasoningEffort: string
  readonly compactProvider: string
  readonly compactModel: string
  readonly compactReasoningEffort: string
  readonly autoClassifierEnabled: boolean
  readonly autoInstantProvider: string
  readonly autoInstantModel: string
  readonly autoInstantReasoningEffort: string
  readonly autoThinkingProvider: string
  readonly autoThinkingModel: string
  readonly autoThinkingReasoningEffort: string
  readonly autoProProvider: string
  readonly autoProModel: string
  readonly autoProReasoningEffort: string
  readonly autoClassifierProvider: string
  readonly autoClassifierModel: string
  readonly autoClassifierReasoningEffort: string
}

export const DEFAULT_AUXILIARY_MODEL: AuxiliaryModelSettings = {
  provider: '',
  model: '',
  reasoningEffort: '',
}

export const DEFAULT_SETTINGS: EnhancerSettings = {
  historyEnabled: true,
  optimizeEnabled: true,
  predictEnabled: true,
  rollbackEnabled: true,
  contextInspectEnabled: true,
  optimizeProvider: '',
  optimizeModel: '',
  optimizeReasoningEffort: '',
  predictProvider: '',
  predictModel: '',
  predictReasoningEffort: '',
  compactProvider: '',
  compactModel: '',
  compactReasoningEffort: '',
  autoClassifierEnabled: false,
  autoInstantProvider: '',
  autoInstantModel: '',
  autoInstantReasoningEffort: '',
  autoThinkingProvider: '',
  autoThinkingModel: '',
  autoThinkingReasoningEffort: '',
  autoProProvider: '',
  autoProModel: '',
  autoProReasoningEffort: '',
  autoClassifierProvider: '',
  autoClassifierModel: '',
  autoClassifierReasoningEffort: '',
}

function text(value: string | undefined): string {
  return typeof value === 'string' ? value : ''
}

export function resolveSettings(value: Partial<EnhancerSettings> | undefined): EnhancerSettings {
  return {
    historyEnabled: value?.historyEnabled ?? true,
    optimizeEnabled: value?.optimizeEnabled ?? true,
    predictEnabled: value?.predictEnabled ?? true,
    rollbackEnabled: value?.rollbackEnabled ?? true,
    contextInspectEnabled: value?.contextInspectEnabled ?? true,
    optimizeProvider: text(value?.optimizeProvider),
    optimizeModel: text(value?.optimizeModel),
    optimizeReasoningEffort: text(value?.optimizeReasoningEffort),
    predictProvider: text(value?.predictProvider),
    predictModel: text(value?.predictModel),
    predictReasoningEffort: text(value?.predictReasoningEffort),
    compactProvider: text(value?.compactProvider),
    compactModel: text(value?.compactModel),
    compactReasoningEffort: text(value?.compactReasoningEffort),
    autoClassifierEnabled: value?.autoClassifierEnabled ?? false,
    autoInstantProvider: text(value?.autoInstantProvider),
    autoInstantModel: text(value?.autoInstantModel),
    autoInstantReasoningEffort: text(value?.autoInstantReasoningEffort),
    autoThinkingProvider: text(value?.autoThinkingProvider),
    autoThinkingModel: text(value?.autoThinkingModel),
    autoThinkingReasoningEffort: text(value?.autoThinkingReasoningEffort),
    autoProProvider: text(value?.autoProProvider),
    autoProModel: text(value?.autoProModel),
    autoProReasoningEffort: text(value?.autoProReasoningEffort),
    autoClassifierProvider: text(value?.autoClassifierProvider),
    autoClassifierModel: text(value?.autoClassifierModel),
    autoClassifierReasoningEffort: text(value?.autoClassifierReasoningEffort),
  }
}

export function isAutoModel(selection: Pick<AuxiliaryModelSettings, 'provider' | 'model'>): boolean {
  return selection.provider === AUTO_PROVIDER && selection.model === AUTO_MODEL
}

export function autoRouteMapOf(settings: EnhancerSettings): AutoRouteMap {
  return {
    instant: {
      provider: settings.autoInstantProvider,
      model: settings.autoInstantModel,
      reasoningEffort: settings.autoInstantReasoningEffort,
    },
    thinking: {
      provider: settings.autoThinkingProvider,
      model: settings.autoThinkingModel,
      reasoningEffort: settings.autoThinkingReasoningEffort,
    },
    pro: {
      provider: settings.autoProProvider,
      model: settings.autoProModel,
      reasoningEffort: settings.autoProReasoningEffort,
    },
    classifier: {
      provider: settings.autoClassifierProvider,
      model: settings.autoClassifierModel,
      reasoningEffort: settings.autoClassifierReasoningEffort,
    },
  }
}

export function auxiliaryModelOf(
  settings: EnhancerSettings,
  feature: AuxiliaryFeature,
): AuxiliaryModelSettings {
  switch (feature) {
    case 'optimize':
      return {
        provider: settings.optimizeProvider,
        model: settings.optimizeModel,
        reasoningEffort: settings.optimizeReasoningEffort,
      }
    case 'predict':
      return {
        provider: settings.predictProvider,
        model: settings.predictModel,
        reasoningEffort: settings.predictReasoningEffort,
      }
    case 'compact':
      return {
        provider: settings.compactProvider,
        model: settings.compactModel,
        reasoningEffort: settings.compactReasoningEffort,
      }
    default: {
      const _exhaustive: never = feature
      return _exhaustive
    }
  }
}

export function isFollowSessionModel(selection: AuxiliaryModelSettings): boolean {
  return selection.provider === '' || selection.model === ''
}
