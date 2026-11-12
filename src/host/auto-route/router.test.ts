import { describe, expect, it } from 'vitest'
import { AutoRouteUnconfiguredError } from './errors.ts'
import { resolveAutoRoute } from './router.ts'
import type { AutoRouteMap, AutoTierRoute } from './types.ts'

const empty: AutoTierRoute = { provider: '', model: '', reasoningEffort: '' }
const instant: AutoTierRoute = { provider: 'p', model: 'instant', reasoningEffort: '' }
const thinking: AutoTierRoute = { provider: 'p', model: 'thinking', reasoningEffort: 'medium' }

function map(partial: Partial<AutoRouteMap> = {}): AutoRouteMap {
  return {
    instant: empty,
    thinking: empty,
    pro: empty,
    classifier: empty,
    ...partial,
  }
}

describe('resolveAutoRoute', () => {
  it('throws AutoRouteUnconfiguredError when no tier is available and no fallback', async () => {
    await expect(resolveAutoRoute({
      text: 'hello',
      map: map(),
      classifierEnabled: false,
      isAvailable: () => false,
    })).rejects.toBeInstanceOf(AutoRouteUnconfiguredError)
  })

  it('throws when mapped rows exist but none pass isAvailable', async () => {
    await expect(resolveAutoRoute({
      text: 'hello',
      map: map({ instant, thinking }),
      classifierEnabled: false,
      isAvailable: () => false,
      fallback: { provider: 'gone', model: 'gone', reasoningEffort: '' },
    })).rejects.toMatchObject({ code: 'AUTO_ROUTE_UNCONFIGURED' })
  })

  it('returns the first available tier from the heuristic start', async () => {
    const route = await resolveAutoRoute({
      text: 'hi',
      feature: 'optimize',
      map: map({ instant, thinking }),
      classifierEnabled: false,
      isAvailable: (provider, model) => provider === 'p' && model === 'instant',
    })
    expect(route).toEqual({ ...instant, tier: 'instant' })
  })

  it('falls upward when preferred Instant model is unavailable', async () => {
    const route = await resolveAutoRoute({
      text: 'hi',
      feature: 'predict',
      map: map({ instant, thinking }),
      classifierEnabled: false,
      isAvailable: (provider, model) => provider === 'p' && model === 'thinking',
    })
    expect(route).toEqual({ ...thinking, tier: 'thinking' })
  })

  it('uses an available fallback when all Auto tiers are empty', async () => {
    const fallback = { provider: 'fb', model: 'fb-model', reasoningEffort: 'low' }
    const route = await resolveAutoRoute({
      text: 'hi',
      map: map(),
      classifierEnabled: false,
      isAvailable: (provider, model) => provider === 'fb' && model === 'fb-model',
      fallback,
    })
    expect(route).toEqual({ ...fallback, tier: 'thinking' })
  })
})
