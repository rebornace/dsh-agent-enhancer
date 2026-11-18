import { describe, expect, it, vi } from 'vitest'
import { resolveAutoRoute } from '../src/host/auto-route/router.ts'

const map = {
  instant: { provider: 'p', model: 'flash', reasoningEffort: '' },
  thinking: { provider: 'p', model: 'chat', reasoningEffort: '' },
  pro: { provider: 'p', model: 'reasoner', reasoningEffort: 'high' },
  classifier: { provider: 'p', model: 'flash', reasoningEffort: '' },
}

describe('resolveAutoRoute', () => {
  it('uses heuristic when classifier disabled', async () => {
    const route = await resolveAutoRoute({
      text: 'hi',
      feature: 'predict',
      map,
      classifierEnabled: false,
      isAvailable: () => true,
    })
    expect(route).toEqual({ provider: 'p', model: 'flash', reasoningEffort: '', tier: 'instant' })
  })

  it('falls back when mapped model unavailable', async () => {
    const route = await resolveAutoRoute({
      text: 'hi',
      feature: 'predict',
      map,
      classifierEnabled: false,
      isAvailable: (p, m) => m !== 'flash',
    })
    expect(route.model).toBe('chat')
  })

  it('uses classifier tier when enabled', async () => {
    const classify = vi.fn(async () => 'pro' as const)
    const route = await resolveAutoRoute({
      text: 'x',
      feature: 'session',
      map,
      classifierEnabled: true,
      classify,
      isAvailable: () => true,
    })
    expect(classify).toHaveBeenCalledOnce()
    expect(route.tier).toBe('pro')
    expect(route.model).toBe('reasoner')
  })

  it('falls back to heuristic when classify throws', async () => {
    const route = await resolveAutoRoute({
      text: 'hi',
      feature: 'predict',
      map,
      classifierEnabled: true,
      classify: async () => { throw new Error('boom') },
      isAvailable: () => true,
    })
    expect(route.tier).toBe('instant')
  })
})
