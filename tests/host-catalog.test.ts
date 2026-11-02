import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAuxiliaryModelCatalog } from '../src/host/catalog.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('buildAuxiliaryModelCatalog', () => {
  it('lists providers with resolved reasoning metadata and isolates provider failures', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' }),
    } as never)
    ctx.provide('llm', {
      listProviders: () => [
        { id: 'deepseek', name: 'DeepSeek' },
        { id: 'broken', name: 'Broken' },
      ],
      listModels: vi.fn(async (provider: string) => {
        if (provider === 'broken') throw new Error('provider down')
        return [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }]
      }),
      resolveModelInfo: vi.fn(async () => ({
        provider: 'deepseek',
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        reasoning: {
          efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
          defaultEffort: 'low',
        },
      })),
    } as never)

    await expect(buildAuxiliaryModelCatalog(ctx)).resolves.toEqual({
      default: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' },
      routableProviders: ['deepseek'],
      groups: [{
        id: 'deepseek',
        name: 'DeepSeek',
        models: [{
          id: 'deepseek-chat',
          name: 'DeepSeek Chat',
          reasoning: {
            efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
            defaultEffort: 'low',
          },
        }],
      }],
      failures: [{ id: 'broken', name: 'Broken', message: 'provider down' }],
    })
  })
})
