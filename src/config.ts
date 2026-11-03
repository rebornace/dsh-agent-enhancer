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
