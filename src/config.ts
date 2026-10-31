export const MODULES = ['history', 'optimize', 'predict'] as const
export type ModuleName = typeof MODULES[number]
export type EnhancerSettings = Readonly<Record<`${ModuleName}Enabled`, boolean>>
export const DEFAULT_SETTINGS: EnhancerSettings = {
  historyEnabled: true, optimizeEnabled: true, predictEnabled: true,
}
export function resolveSettings(value: Partial<EnhancerSettings> | undefined): EnhancerSettings {
  return {
    historyEnabled: value?.historyEnabled ?? true,
    optimizeEnabled: value?.optimizeEnabled ?? true,
    predictEnabled: value?.predictEnabled ?? true,
  }
}
