export const MODULES = ['history', 'optimize', 'predict', 'rollback'] as const
export type ModuleName = typeof MODULES[number]

export type AuxiliaryFeature = 'optimize' | 'predict'

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
  optimizeProvider: '',
  optimizeModel: '',
  optimizeReasoningEffort: '',
  predictProvider: '',
  predictModel: '',
  predictReasoningEffort: '',
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
    optimizeProvider: text(value?.optimizeProvider),
    optimizeModel: text(value?.optimizeModel),
    optimizeReasoningEffort: text(value?.optimizeReasoningEffort),
    predictProvider: text(value?.predictProvider),
    predictModel: text(value?.predictModel),
    predictReasoningEffort: text(value?.predictReasoningEffort),
  }
}

export function auxiliaryModelOf(
  settings: EnhancerSettings,
  feature: AuxiliaryFeature,
): AuxiliaryModelSettings {
  if (feature === 'optimize') {
    return {
      provider: settings.optimizeProvider,
      model: settings.optimizeModel,
      reasoningEffort: settings.optimizeReasoningEffort,
    }
  }
  return {
    provider: settings.predictProvider,
    model: settings.predictModel,
    reasoningEffort: settings.predictReasoningEffort,
  }
}

export function isFollowSessionModel(selection: AuxiliaryModelSettings): boolean {
  return selection.provider === '' || selection.model === ''
}
