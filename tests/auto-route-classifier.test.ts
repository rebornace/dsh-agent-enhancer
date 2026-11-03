import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createClassifier, parseClassifierTier } from '../src/host/auto-route/classifier.ts'

function textChunks(text: string): StreamChunk[] {
  return [{ type: 'text-delta', index: 0, text }, { type: 'finish', reason: { kind: 'stop' } }]
}

function iterable(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

describe('parseClassifierTier', () => {
  it.each([
    ['instant', 'instant'],
    ['  THINKING ', 'thinking'],
    ['Pro', 'pro'],
    ['{"tier":"pro"}', 'pro'],
    ['`thinking`', 'thinking'],
  ] as const)('parses %j as %s', (input, expected) => {
    expect(parseClassifierTier(input)).toBe(expected)
  })

  it.each(['', 'maybe', 'instantaneous', 'professional'])('returns undefined for %j', (input) => {
    expect(parseClassifierTier(input)).toBeUndefined()
  })
})

describe('createClassifier', () => {
  const route = { provider: 'p', model: 'flash', reasoningEffort: '' }

  it('calls prepareCall with classifier route and maxTokens 8', async () => {
    const stream = vi.fn((_options: GenerateOptions) => iterable(textChunks('pro')))
    const prepareCall = vi.fn(async (config: LlmCallConfig) => ({
      config: { provider: config.provider, model: config.model, maxTokens: config.maxTokens },
      stream,
    }))
    const classify = createClassifier({ prepareCall: prepareCall as never }, route)
    await expect(classify('long task')).resolves.toBe('pro')
    expect(prepareCall).toHaveBeenCalledWith(
      { provider: 'p', model: 'flash', maxTokens: 8 },
      expect.any(AbortSignal),
    )
    expect(stream.mock.calls[0]?.[0].system).toMatch(/instant.*thinking.*pro/i)
    expect(stream.mock.calls[0]?.[0].maxTokens).toBe(8)
  })

  it('throws when output cannot be parsed', async () => {
    const prepareCall = vi.fn(async (config: LlmCallConfig) => ({
      config: { provider: config.provider, model: config.model, maxTokens: config.maxTokens },
      stream: vi.fn(() => iterable(textChunks('unknown'))),
    }))
    const classify = createClassifier({ prepareCall: prepareCall as never }, route)
    await expect(classify('x')).rejects.toThrow(/classifier/i)
  })
})
