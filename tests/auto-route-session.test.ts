import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { LlmAdapter, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveSettings } from '../src/config.ts'
import { installAutoSessionRoute } from '../src/host/auto-route/session-hook.ts'
import { AUTO_MODEL, AUTO_PROVIDER } from '../src/host/auto-route/sentinel.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const settings = resolveSettings({
  autoClassifierEnabled: false,
  autoInstantProvider: 'p',
  autoInstantModel: 'flash',
  autoThinkingProvider: 'p',
  autoThinkingModel: 'chat',
  autoProProvider: 'p',
  autoProModel: 'reasoner',
  autoProReasoningEffort: 'high',
  autoClassifierProvider: 'p',
  autoClassifierModel: 'flash',
})

function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  const prepare = vi.fn(async (config: LlmCallConfig) => ({ config }))
  const registerAdapter = vi.fn((_providers: string[], _adapter: LlmAdapter) => () => {})
  const agent = {
    options: { provider: AUTO_PROVIDER, model: AUTO_MODEL },
    status: 'running',
  }
  ctx.provide('llm', {
    prepareCall: prepare,
    registerAdapter,
    listProviders: () => [],
  } as never)
  ctx.provide('agents', {
    currentInitiator: () => agent,
    list: () => [agent],
  } as never)
  ctx.provide('sessionProjections', {
    stateOf: () => ({ pending: { provider: AUTO_PROVIDER, model: AUTO_MODEL }, lastUsed: null }),
  } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fallback', model: 'default' }),
  } as never)
  installAutoSessionRoute(ctx, { settings: () => settings })
  return { ctx, prepare, registerAdapter, agent }
}

async function admit(ctx: Context, agent: object, text: string): Promise<void> {
  const message = {
    id: MessageId(`user-${text.length}`),
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'user' as const },
  }
  await ctx.waterfall('agent/pre-step', {
    agent,
    messages: [message],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  } as never, async () => ({ kind: 'enter' as const, messages: [message] }))
}

describe('installAutoSessionRoute', () => {
  it('resolves a new heuristic tier for each turn text', async () => {
    const { ctx, prepare, agent } = setup()
    const auto = { provider: AUTO_PROVIDER, model: AUTO_MODEL }

    await admit(ctx, agent, 'hi')
    await ctx.llm.prepareCall(auto)
    await admit(ctx, agent, `${'分析'.repeat(200)} plan thoroughly`)
    await ctx.llm.prepareCall(auto)

    expect(prepare).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ provider: 'p', model: 'flash' }),
      undefined,
      undefined,
    )
    expect(prepare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ provider: 'p', model: 'reasoner', reasoningEffort: 'high' }),
      undefined,
      undefined,
    )
    expect(prepare.mock.calls[0]?.[0]).not.toMatchObject({ model: 'reasoner' })
    expect(prepare.mock.calls[1]?.[0]).not.toMatchObject({ model: 'flash' })
  })

  it('leaves a concrete session model on the original route', async () => {
    const { ctx, prepare } = setup()
    const pinned = { provider: 'deepseek', model: 'deepseek-chat' }
    await ctx.llm.prepareCall(pinned)
    expect(prepare).toHaveBeenCalledWith(pinned, undefined, undefined)
  })

  it('registers the Auto sentinel on the official model catalog', async () => {
    const { registerAdapter } = setup()
    expect(registerAdapter).toHaveBeenCalledWith([AUTO_PROVIDER], expect.any(Object))
    const adapter = registerAdapter.mock.calls[0]?.[1]
    await expect(adapter?.listModels(AUTO_PROVIDER)).resolves.toEqual([
      expect.objectContaining({ provider: AUTO_PROVIDER, id: AUTO_MODEL, name: 'Auto' }),
    ])
  })
})
