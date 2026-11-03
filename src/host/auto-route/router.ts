import { pickTierHeuristic } from './heuristic.ts'
import type { AutoRouteMap, AutoTier, AutoTierRoute, HeuristicInput } from './types.ts'

const TIER_ORDER: readonly AutoTier[] = ['pro', 'thinking', 'instant']

function tiersFrom(start: AutoTier): readonly AutoTier[] {
  const idx = TIER_ORDER.indexOf(start)
  return TIER_ORDER.slice(idx)
}

function routeForTier(
  map: AutoRouteMap,
  tier: AutoTier,
  isAvailable: (provider: string, model: string) => boolean,
): AutoTierRoute | undefined {
  const route = map[tier]
  if (isAvailable(route.provider, route.model)) {
    return route
  }
  return undefined
}

async function pickTier(options: {
  readonly text: string
  readonly feature?: HeuristicInput['feature']
  readonly toolHeavy?: boolean
  readonly classifierEnabled: boolean
  readonly classify?: (text: string, signal?: AbortSignal) => Promise<AutoTier>
  readonly signal?: AbortSignal
}): Promise<AutoTier> {
  const heuristicInput: HeuristicInput = {
    text: options.text,
    feature: options.feature,
    toolHeavy: options.toolHeavy,
  }

  if (options.classifierEnabled && options.classify) {
    try {
      return await options.classify(options.text, options.signal)
    } catch {
      return pickTierHeuristic(heuristicInput)
    }
  }

  return pickTierHeuristic(heuristicInput)
}

export async function resolveAutoRoute(options: {
  readonly text: string
  readonly feature?: HeuristicInput['feature']
  readonly toolHeavy?: boolean
  readonly map: AutoRouteMap
  readonly classifierEnabled: boolean
  readonly classify?: (text: string, signal?: AbortSignal) => Promise<AutoTier>
  readonly isAvailable: (provider: string, model: string) => boolean
  readonly signal?: AbortSignal
  readonly fallback?: AutoTierRoute
}): Promise<AutoTierRoute & { tier: AutoTier }> {
  const tier = await pickTier(options)

  for (const candidate of tiersFrom(tier)) {
    const route = routeForTier(options.map, candidate, options.isAvailable)
    if (route) {
      return { ...route, tier: candidate }
    }
  }

  const fallback = options.fallback ?? options.map.thinking
  return { ...fallback, tier: 'thinking' }
}
