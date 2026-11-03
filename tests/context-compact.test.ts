import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DEFAULT_SETTINGS } from '../src/config.ts'
import { AuxiliaryError } from '../src/errors.ts'
import { AUTO_MODEL, AUTO_PROVIDER } from '../src/host/auto-route/sentinel.ts'
import { setSessionResolvedRouteForSession } from '../src/host/auto-route/session-resolved-route.ts'
import { compactContextNow, resolveCompactRouteOverride } from '../src/host/context-compact.ts'
import { AgentEnhancerService } from '../src/host/index.ts'

describe('compactContextNow', () => {
  it('parses official /compact success text', async () => {
    const execute = vi.fn(async () => ({
      commandId: 'c1',
      result: { kind: 'success' as const, text: 'Compacted 3 history items (~420 tokens).' },
    }))
    const result = await compactContextNow({
      commands: { execute } as never,
      agent: { status: 'idle', options: {} },
      sessionId: 's1' as never,
      signal: new AbortController().signal,
    })
    expect(result).toEqual({
      sessionId: 's1',
      status: 'compacted',
      shadowedCount: 3,
      shadowedTokens: 420,
    })
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      '/compact',
      [],
      expect.any(AbortSignal),
    )
  })

  it('returns noop when official command finds nothing', async () => {
    const result = await compactContextNow({
      commands: {
        execute: vi.fn(async () => ({
          commandId: 'c1',
          result: { kind: 'success' as const, text: 'No compactable history yet.' },
        })),
      } as never,
      agent: { status: 'idle', options: {} },
      sessionId: 's1' as never,
      signal: new AbortController().signal,
    })
    expect(result.status).toBe('noop')
  })

  it('maps busy error text to COMPACT_BUSY', async () => {
    await expect(compactContextNow({
      commands: {
        execute: vi.fn(async () => ({
          commandId: 'c1',
          result: { kind: 'error' as const, text: 'The agent is busy.' },
        })),
      } as never,
      agent: { status: 'idle', options: {} },
      sessionId: 's1' as never,
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining({ code: 'COMPACT_BUSY' }) as AuxiliaryError)
  })

  it('maps summary error text to COMPACT_SUMMARY', async () => {
    await expect(compactContextNow({
      commands: {
        execute: vi.fn(async () => ({
          commandId: 'c1',
          result: {
            kind: 'error' as const,
            text: 'Compaction could not produce a useful summary.',
          },
        })),
      } as never,
      agent: { status: 'idle', options: {} },
      sessionId: 's1' as never,
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining({ code: 'COMPACT_SUMMARY' }) as AuxiliaryError)
  })

  it('routes compact Auto selections through AutoRouter mapping during /compact', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      compactProvider: AUTO_PROVIDER,
      compactModel: AUTO_MODEL,
      autoClassifierEnabled: false,
      autoThinkingProvider: 'think-p',
      autoThinkingModel: 'think-m',
    }
    const ctx = {
      agentDefaultModel: { currentSelection: () => ({ provider: 'd', model: 'chat' }) },
      sessionProjections: { stateOf: () => undefined },
    } as never
    const session = { requestHeader: () => undefined } as never
    const route = await resolveCompactRouteOverride(
      ctx,
      settings,
      session,
      new AbortController().signal,
    )
    expect(route).toEqual({ provider: 'think-p', model: 'think-m' })

    const options = { provider: 'session-p', model: 'session-m' }
    const execute = vi.fn(async (agent: { options: { provider: string, model: string } }) => {
      expect(agent.options).toEqual({ provider: 'think-p', model: 'think-m' })
      return {
        commandId: 'c1',
        result: { kind: 'success' as const, text: 'No compactable history yet.' },
      }
    })
    await compactContextNow({
      commands: { execute } as never,
      agent: { status: 'idle', options },
      sessionId: 's1' as never,
      signal: new AbortController().signal,
      route,
    })
    expect(options).toEqual({ provider: 'session-p', model: 'session-m' })
  })

  it('reuses cached session turn route when compact follows Auto session', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      autoClassifierEnabled: false,
      autoInstantProvider: 'p',
      autoInstantModel: 'flash',
      autoThinkingProvider: 'p',
      autoThinkingModel: 'chat',
    }
    const session = { requestHeader: () => undefined } as never
    setSessionResolvedRouteForSession(session, {
      provider: 'p',
      model: 'chat',
      reasoningEffort: '',
    })
    const ctx = {
      agentDefaultModel: { currentSelection: () => ({ provider: AUTO_PROVIDER, model: AUTO_MODEL }) },
      sessionProjections: {
        stateOf: () => ({ pending: { provider: AUTO_PROVIDER, model: AUTO_MODEL }, lastUsed: null }),
      },
    } as never
    const route = await resolveCompactRouteOverride(
      ctx,
      settings,
      session,
      new AbortController().signal,
    )
    expect(route).toEqual({ provider: 'p', model: 'chat' })
  })

  it('overrides agent route while /compact runs', async () => {
    const options = { provider: 'session-p', model: 'session-m' }
    const execute = vi.fn(async (agent: { options: { provider: string, model: string } }) => {
      expect(agent.options).toEqual({ provider: 'compact-p', model: 'compact-m' })
      return {
        commandId: 'c1',
        result: { kind: 'success' as const, text: 'No compactable history yet.' },
      }
    })
    await compactContextNow({
      commands: { execute } as never,
      agent: { status: 'idle', options },
      sessionId: 's1' as never,
      signal: new AbortController().signal,
      route: { provider: 'compact-p', model: 'compact-m' },
    })
    expect(options).toEqual({ provider: 'session-p', model: 'session-m' })
  })

  it('rejects when command registry is missing', async () => {
    await expect(compactContextNow({
      commands: undefined,
      agent: { status: 'idle', options: {} },
      sessionId: 's1' as never,
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining({ code: 'COMPACT_UNAVAILABLE' }) as AuxiliaryError)
  })

  it('rejects non-idle agents as COMPACT_BUSY', async () => {
    await expect(compactContextNow({
      commands: { execute: vi.fn() } as never,
      agent: { status: 'running', options: {} },
      sessionId: 's1' as never,
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining({ code: 'COMPACT_BUSY' }) as AuxiliaryError)
  })
})

describe('AgentEnhancerService.compactContext', () => {
  it('dispatches /compact through injected commands', async () => {
    const root = new Context()
    const execute = vi.fn(async () => ({
      commandId: 'c1',
      result: { kind: 'success' as const, text: 'Compacted 1 history items (~12 tokens).' },
    }))
    root.provide('commands', { execute } as never)
    root.provide('agents', {
      get: () => ({ status: 'idle', options: {}, session: { requestHeader: () => undefined } }),
    } as never)
    root.provide('invocation', { peer: { principal: { kind: 'owner' } } } as never)

    let result: unknown
    await root.plugin({
      name: 'agent-enhancer-compact-probe',
      inject: ['commands', 'agents'],
      apply(ctx: Context) {
        const service = new AgentEnhancerService(
          ctx,
          {} as never,
          async (_session, _signal) => ({ provider: '', model: '' }),
        )
        return (async () => {
          result = await service.compactContext({ sessionId: 's1' as never }, new AbortController().signal)
        })()
      },
    })

    expect(result).toEqual({
      sessionId: 's1',
      status: 'compacted',
      shadowedCount: 1,
      shadowedTokens: 12,
    })
    expect(execute).toHaveBeenCalledOnce()
    await root.fiber.dispose()
  })
})
