export type AutoTier = 'instant' | 'thinking' | 'pro'

export interface AutoTierRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string
}

export interface AutoRouteMap {
  readonly instant: AutoTierRoute
  readonly thinking: AutoTierRoute
  readonly pro: AutoTierRoute
  readonly classifier: AutoTierRoute
}

export interface HeuristicInput {
  readonly text: string
  readonly feature?: 'optimize' | 'predict' | 'compact' | 'session'
  readonly toolHeavy?: boolean
}
