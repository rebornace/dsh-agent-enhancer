import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { DEFAULT_SETTINGS } from '../src/config.ts'
import { AuxiliaryError } from '../src/errors.ts'
import { AUTO_MODEL, AUTO_PROVIDER } from '../src/host/auto-route/sentinel.ts'
import { setSessionResolvedRouteForSession } from '../src/host/auto-route/session-resolved-route.ts'
import { compactContextNow, resolveCompactRouteOverride } from '../src/host/context-compact.ts'
import { AgentEnhancerService } from '../src/host/index.ts'

const compactRouteContexts: Context[] = []

afterEach(async () => {
  for (const ctx of compactRouteContexts.splice(0)) await ctx.fiber.dispose()
})

function provideCompactRouteCtx(
  pending: { provider: string, model: string } | undefined,
  defaultSelection: { provider: string, model: string },
  sessionId: string = 's1',
): Context {
  const ctx = new Context()
  compactRouteContexts.push(ctx)
  ctx.provide('agents', {
    get: (id: unknown) => id === sessionId
      ? { model: { current: () => pending } }
      : undefined,
  } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => defaultSelection,
  } as never)
  return ctx
}

function idleAgent(overrides: Record<string, unknown> = {}) {
  return {
    status: 'idle',
    options: {},
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) =>
      task(new AbortController().signal),
    ...overrides,
  }
}

describe('compactContextNow', () => {
  it('uses compactNow when the engine is available', async () => {
    const compactNow = vi.fn(async () => ({
      shadowedSeqs: ['a', 'b', 'c'],
      shadowedTokenCount: 420,
    }))
    const execute = vi.fn()
    const result = await compactContextNow({
      compaction: { compactNow } as never,
      commands: { execute } as never,
      agent: idleAgent(),
      sessionId: 's1' as never,
      signal: new AbortController().signal,
    })
    expect(result).toEqual({
      sessionId: 's1',
      status: 'compacted',
      shadowedCount: 3,
      shadowedTokens: 420,
    })
    expect(compactNow).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
  })

  it('returns noop when compactNow finds nothing', async () => {
    const result = await compactContextNow({
      compaction: { compactNow: vi.fn(async () => null) } as never,
      commands: { execute: vi.fn() } as never,
      agent: idleAgent(),
      sessionId: 's1' as never,
      signal: new AbortController().signal,
    })
    expect(result.status).toBe('noop')
  })

  it('maps ManualCompactionError codes from compactNow', async () => {
    await expect(compactContextNow({
      compaction: {
        compactNow: vi.fn(async () => {
          throw new ManualCompactionError('summary', 'manual compaction could not produce a smaller summary')
        }),
      } as never,
      commands: { execute: vi.fn() } as never,
      agent: idleAgent(),
      sessionId: 's1' as never,
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining({ code: 'COMPACT_SUMMARY' }) as AuxiliaryError)
  })

  it('falls back to /compact when compactNow is unavailable', async () => {
    const execute = vi.fn(async () => ({
      commandId: 'c1',
      result: { kind: 'success' as const, text: 'Compacted 3 history items (~420 tokens).' },
    }))
    const result = await compactContextNow({
      compaction: undefined,
      commands: { execute } as never,
      agent: idleAgent({ runMaintenance: undefined }),
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
      compaction: undefined,
      commands: {
        execute: vi.fn(async () => ({
          commandId: 'c1',
          result: { kind: 'success' as const, text: 'No compactable history yet.' },
        })),
      } as never,
      agent: idleAgent({ runMaintenance: undefined }),
      sessionId: 's1' as never,
      signal: new AbortController().signal,
    })
    expect(result.status).toBe('noop')
  })

  it('maps busy error text to COMPACT_BUSY', async () => {
    await expect(compactContextNow({
      compaction: undefined,
      commands: {
        execute: vi.fn(async () => ({
          commandId: 'c1',
          result: { kind: 'error' as const, text: 'The agent is busy.' },
        })),
      } as never,
      agent: idleAgent({ runMaintenance: undefined }),
      sessionId: 's1' as never,
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining({ code: 'COMPACT_BUSY' }) as AuxiliaryError)
  })

  it('does not mutate agent options while compaction runs', async () => {
    const options = { provider: 'session-p', model: 'session-m' }
    const compactNow = vi.fn(async (agent: { options: { provider: string, model: string } }) => {
      expect(agent.options).toEqual({ provider: 'session-p', model: 'session-m' })
      return null
    })
    await compactContextNow({
      compaction: { compactNow } as never,
      commands: { execute: vi.fn() } as never,
      agent: idleAgent({ options }),
      sessionId: 's1' as never,
      signal: new AbortController().signal,
    })
    expect(options).toEqual({ provider: 'session-p', model: 'session-m' })
  })

  it('rejects when neither engine nor command registry is available', async () => {
    await expect(compactContextNow({
      compaction: undefined,
      commands: undefined,
      agent: idleAgent({ runMaintenance: undefined }),
      sessionId: 's1' as never,
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining({ code: 'COMPACT_UNAVAILABLE' }) as AuxiliaryError)
  })

  it('rejects non-idle agents as COMPACT_BUSY', async () => {
    await expect(compactContextNow({
      compaction: { compactNow: vi.fn() } as never,
      commands: { execute: vi.fn() } as never,
      agent: idleAgent({ status: 'running' }),
      sessionId: 's1' as never,
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining({ code: 'COMPACT_BUSY' }) as AuxiliaryError)
  })
})

describe('resolveCompactRouteOverride', () => {
  it('routes compact Auto selections through AutoRouter mapping', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      compactProvider: AUTO_PROVIDER,
      compactModel: AUTO_MODEL,
      autoClassifierEnabled: false,
      autoThinkingProvider: 'think-p',
      autoThinkingModel: 'think-m',
    }
    const session = { id: 's1', requestHeader: () => undefined } as never
    const ctx = provideCompactRouteCtx(undefined, { provider: 'd', model: 'chat' })
    const route = await resolveCompactRouteOverride(
      ctx,
      settings,
      session,
      new AbortController().signal,
    )
    expect(route).toEqual({ provider: 'think-p', model: 'think-m' })
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
    const session = { id: 's1', requestHeader: () => undefined } as never
    setSessionResolvedRouteForSession(session, {
      provider: 'p',
      model: 'chat',
      reasoningEffort: '',
    })
    const ctx = provideCompactRouteCtx(
      { provider: AUTO_PROVIDER, model: AUTO_MODEL },
      { provider: AUTO_PROVIDER, model: AUTO_MODEL },
    )
    const route = await resolveCompactRouteOverride(
      ctx,
      settings,
      session,
      new AbortController().signal,
    )
    expect(route).toEqual({ provider: 'p', model: 'chat' })
  })

  it('on cache miss, rematches follow+Auto compact from session turn text', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      autoClassifierEnabled: false,
      autoInstantProvider: 'p',
      autoInstantModel: 'flash',
      autoThinkingProvider: 'p',
      autoThinkingModel: 'chat',
      autoProProvider: 'p',
      autoProModel: 'reasoner',
      autoProReasoningEffort: 'high',
    }
    const session = {
      id: 's1',
      requestHeader: () => undefined,
      snapshotEvents: () => [{
        type: 'user/message',
        data: {
          content: [{
            type: 'text',
            text: '请深入分析并仔细推理以下长文：' + 'x'.repeat(800),
          }],
        },
      }],
    } as never
    const ctx = provideCompactRouteCtx(
      { provider: AUTO_PROVIDER, model: AUTO_MODEL },
      { provider: AUTO_PROVIDER, model: AUTO_MODEL },
    )
    const route = await resolveCompactRouteOverride(
      ctx,
      settings,
      session,
      new AbortController().signal,
    )
    expect(route).toEqual({ provider: 'p', model: 'reasoner' })
  })
})

describe('AgentEnhancerService.compactContext', () => {
  it('dispatches through compactNow when the engine is injected', async () => {
    const root = new Context()
    const compactNow = vi.fn(async () => ({
      shadowedSeqs: ['x'],
      shadowedTokenCount: 12,
    }))
    const execute = vi.fn()
    root.provide('compaction', { compactNow } as never)
    root.provide('commands', { execute } as never)
    root.provide('agents', {
      get: () => idleAgent({
        session: { id: 's1', requestHeader: () => undefined },
      }),
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
    expect(compactNow).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    await root.fiber.dispose()
  })
})
