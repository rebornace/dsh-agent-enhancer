import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentEnhancerService } from '../src/host/index.ts'
import { agentLocales } from '../src/client/locales.ts'
import { usageSummarySchema } from '../src/host/rpc.ts'
import { UsageLedger } from '../src/host/usage/ledger.ts'
import { observeModelStream } from '../src/host/usage/observe.ts'
import { classifyUsageSource, stampUsageSource, withUsageSource } from '../src/host/usage/source.ts'
import { mergeUsageCalls, sessionUsageFromEvents } from '../src/host/usage/history.ts'
import {
  BalanceCache,
  fetchDeepSeekBalance,
  loadProviderBalances,
  parseAccountBalanceResult,
  parseBalanceResponse,
  resolveDeepSeekApiKey,
} from '../src/host/usage/balance.ts'
import {
  estimateCallCost,
  isPeakTime,
  normalizePricedModel,
  unitPriceAt,
} from '../src/host/usage/pricing.ts'
import { retainUsageCalls, summarizeUsage, usageCallFromReport } from '../src/host/usage/summarize.ts'
import { MAX_USAGE_CALLS, USAGE_RETENTION_DAYS } from '../src/host/usage/types.ts'
import type { UsageCall } from '../src/host/usage/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function request(partial: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    messages: [],
    ...partial,
  }
}

function call(partial: Partial<UsageCall> & Pick<UsageCall, 'at' | 'source'>): UsageCall {
  return {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: '',
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...partial,
  }
}

describe('model bill attribution', () => {
  it('prefers the plugin feature over the request purpose', async () => {
    const options = request({ purpose: 'compaction' as never })
    expect(classifyUsageSource(options)).toBe('compaction')
    await withUsageSource('compact', async () => {
      expect(classifyUsageSource(options)).toBe('compact')
    })
    expect(classifyUsageSource(request({ purpose: 'session-title' as never }))).toBe('sessionTitle')
  })

  it('keeps a stamped plugin source after ALS ends', () => {
    const options = request({ system: 'rewrite', sessionId: 's1' as GenerateOptions['sessionId'] })
    stampUsageSource(options, 'optimize')
    expect(classifyUsageSource(options)).toBe('optimize')
  })

  it('counts marked loop calls and unmarked session calls as desktop sessions', () => {
    expect(classifyUsageSource(markAgentLoopRequest(request()))).toBe('session')
    expect(classifyUsageSource(request({ sessionId: 's1' as GenerateOptions['sessionId'] }))).toBe('session')
    expect(classifyUsageSource(request({ system: 'rewrite' }))).toBe('other')
  })

  it('records a reported usage chunk without dropping the stream when recording throws', async () => {
    const recorded: UsageCall[] = []
    async function* chunks() {
      yield { type: 'text-delta' as const, index: 0, text: 'ok' }
      yield { type: 'usage' as const, usage: { inputTokens: 4, outputTokens: 1, cacheReadTokens: 2 } }
      yield { type: 'usage' as const, usage: { inputTokens: -1, outputTokens: 1 } }
    }
    const seen: string[] = []
    const options = request({ purpose: 'session-title' as never })
    for await (const chunk of observeModelStream(
      options,
      chunks(),
      call => {
        recorded.push(call)
        throw new Error('disk')
      },
      () => 50,
      'optimize',
    )) seen.push(chunk.type)
    expect(seen).toEqual(['text-delta', 'usage', 'usage'])
    expect(recorded).toEqual([expect.objectContaining({
      source: 'optimize',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: '',
      inputTokens: 4,
      outputTokens: 1,
      cacheReadTokens: 2,
    })])
  })

  it('records the effective reasoning effort from the stream options', async () => {
    const recorded: UsageCall[] = []
    async function* chunks() {
      yield { type: 'usage' as const, usage: { inputTokens: 2, outputTokens: 1 } }
    }
    for await (const _ of observeModelStream(
      request({ reasoningEffort: 'high' as GenerateOptions['reasoningEffort'] }),
      chunks(),
      call => { recorded.push(call) },
      () => 9,
      'session',
    )) { /* drain */ }
    expect(recorded[0]?.reasoningEffort).toBe('high')
  })

  it('keeps a valid report and drops unsafe token counts', () => {
    expect(usageCallFromReport('predict', ' p ', ' m ', {
      inputTokens: 3,
      outputTokens: 1,
      reasoningTokens: 1,
    }, 9, ' low ')).toEqual({
      at: 9,
      source: 'predict',
      provider: 'p',
      model: 'm',
      reasoningEffort: 'low',
      inputTokens: 3,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 1,
    })
    expect(usageCallFromReport('predict', '', 'm', { inputTokens: 1, outputTokens: 1 }, 9)).toBeUndefined()
    expect(usageCallFromReport('predict', 'p', 'm', { inputTokens: 1.5, outputTokens: 1 }, 9)).toBeUndefined()
  })
})

describe('model bill summary', () => {
  const now = Date.UTC(2026, 10, 3, 12, 0, 0)

  it('groups plugin features even at zero and keeps desktop calls that happened', () => {
    const summary = summarizeUsage([
      call({
        at: now - 60_000,
        source: 'optimize',
        inputTokens: 8,
        cacheReadTokens: 4,
        reasoningTokens: 1,
        reasoningEffort: 'high',
      }),
      call({
        at: now - 30_000,
        source: 'optimize',
        model: 'deepseek-v4-pro',
        inputTokens: 2,
        reasoningEffort: 'low',
      }),
      call({
        at: now - 20_000,
        source: 'optimize',
        model: 'deepseek-v4-pro',
        inputTokens: 3,
        reasoningEffort: 'high',
      }),
      call({ at: now - 10_000, source: 'session', inputTokens: 100, outputTokens: 20, reasoningEffort: 'high' }),
      call({ at: now - 8 * 24 * 60 * 60 * 1000, source: 'sessionTitle', inputTokens: 5 }),
    ], '7d', now)
    expect(usageSummarySchema.parse(summary)).toEqual(summary)
    expect(summary.sources.map(source => source.source)).toEqual([
      'optimize', 'predict', 'compact', 'autoClassifier', 'session',
    ])
    const optimize = summary.sources[0]!
    expect(optimize.calls).toBe(3)
    expect(optimize.inputTokens).toBe(13)
    expect(optimize.cacheReadTokens).toBe(4)
    expect(optimize.models.map(model => `${model.model}:${model.reasoningEffort}`)).toEqual([
      'deepseek-v4-flash:high',
      'deepseek-v4-pro:high',
      'deepseek-v4-pro:low',
    ])
    expect(summary.calls).toBe(4)
    expect(summary.money.currency).toBe('CNY')
    expect(summary.money.pricedCalls).toBe(4)
    expect(summary.money.unpricedCalls).toBe(0)
    expect(summary.money.estimatedCost).toBeGreaterThan(0)
    expect(summary.recent[0]?.source).toBe('session')
    expect(summary.heatmap.grain).toBe('day')
    expect(summary.heatmap.cells).toHaveLength(7)
    expect(summary.heatmap.cells.some(cell => cell.tokens > 0)).toBe(true)
    const today = summarizeUsage(summary.recent, 'today', now)
    expect(today.heatmap.grain).toBe('hour')
    expect(today.heatmap.cells).toHaveLength(24)
    expect(today.sources.find(source => source.source === 'sessionTitle')).toBeUndefined()
  })

  it('drops calls older than the retention window and caps the saved length', () => {
    const old = call({ at: now - (USAGE_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000, source: 'other' })
    const kept = Array.from({ length: MAX_USAGE_CALLS + 5 }, (_, index) => call({
      at: now - index * 1000,
      source: 'predict',
    }))
    const retained = retainUsageCalls([old, ...kept], now)
    expect(retained).toHaveLength(MAX_USAGE_CALLS)
    expect(retained.some(item => item.at === old.at)).toBe(false)
    expect(agentLocales.zh.usageRetention).toContain(String(USAGE_RETENTION_DAYS))
    expect(agentLocales.zh.usageRetention).toContain(String(MAX_USAGE_CALLS))
    expect(agentLocales.en.usageRetention).toContain(String(USAGE_RETENTION_DAYS))
    expect(agentLocales.en.usageRetention).toContain(String(MAX_USAGE_CALLS))
  })
})

describe('model bill pricing', () => {
  const peak = Date.parse('2026-11-03T10:00:00+08:00') // Tue mid-morning Beijing
  const offPeak = Date.parse('2026-11-03T20:00:00+08:00')
  const weekend = Date.parse('2026-11-07T10:00:00+08:00') // Sat

  it('maps flash aliases and prices peak vs off-peak CNY rates', () => {
    expect(normalizePricedModel('deepseek-v4-flash')).toBe('deepseek-flash')
    expect(isPeakTime(peak)).toBe(true)
    expect(isPeakTime(offPeak)).toBe(false)
    expect(isPeakTime(weekend)).toBe(false)
    expect(unitPriceAt('deepseek-flash', offPeak)).toEqual({
      input: 1, cacheRead: 0.02, output: 4,
    })
    expect(unitPriceAt('deepseek-v4-flash', peak)).toEqual({
      input: 2, cacheRead: 0.04, output: 8,
    })
    expect(estimateCallCost({
      at: offPeak,
      model: 'deepseek-flash',
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    })).toBeCloseTo(5.02, 6)
    expect(estimateCallCost({
      at: peak,
      model: 'deepseek-v4-pro',
      inputTokens: 1_000_000,
      cacheReadTokens: 0,
      outputTokens: 1_000_000,
    })).toBeCloseTo(36, 6)
    expect(estimateCallCost({
      at: peak,
      model: 'unknown-model',
      inputTokens: 10,
      cacheReadTokens: 0,
      outputTokens: 1,
    })).toBeNull()
  })
})

describe('model bill balance', () => {
  it('parses CNY balance rows from the official payload shape', () => {
    expect(parseBalanceResponse({
      is_available: true,
      balance_infos: [
        {
          currency: 'USD',
          total_balance: '1.00',
          granted_balance: '0.00',
          topped_up_balance: '1.00',
        },
        {
          currency: 'CNY',
          total_balance: '110.00',
          granted_balance: '10.00',
          topped_up_balance: '100.00',
        },
      ],
    })).toEqual({
      available: true,
      currency: 'CNY',
      total: '110.00',
      granted: '10.00',
      toppedUp: '100.00',
    })
    expect(parseBalanceResponse({
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: '12.3456789',
        granted_balance: '0.1',
        topped_up_balance: '12.2456789',
      }],
    })).toEqual({
      available: true,
      currency: 'CNY',
      total: '12.35',
      granted: '0.10',
      toppedUp: '12.25',
    })
    expect(parseBalanceResponse({ ok: true })).toBeUndefined()
  })

  it('prefers Desktop credentials over process env and never invents a key', async () => {
    await expect(resolveDeepSeekApiKey({
      credentials: {
        async resolve() {
          return { value: ' from-desktop ' }
        },
      },
      env: { DEEPSEEK_API_KEY: 'from-env' },
    })).resolves.toBe('from-desktop')
    await expect(resolveDeepSeekApiKey({
      env: { DEEPSEEK_API_KEY: 'from-env' },
    })).resolves.toBe('from-env')
    await expect(resolveDeepSeekApiKey({ env: {} })).resolves.toBeUndefined()
  })

  it('fetches balance when Desktop credentials resolve a key', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: '12.34',
        granted_balance: '0.00',
        topped_up_balance: '12.34',
      }],
    }), { status: 200 }))
    await expect(fetchDeepSeekBalance({
      credentials: {
        async resolve() {
          return { value: 'sk-test' }
        },
      },
      env: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 42,
    })).resolves.toMatchObject({
      status: 'ready',
      balance: { total: '12.34', currency: 'CNY', checkedAt: 42 },
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit] | undefined)?.[1]
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer sk-test' })
  })

  it('maps Platform account wallets and keeps API-key balance independent', async () => {
    expect(parseAccountBalanceResult(null)).toEqual({
      source: 'account',
      status: 'signed-out',
    })
    expect(parseAccountBalanceResult({
      status: 'ready',
      value: [{ currency: 'CNY', balance: '20.001234' }],
      bonusWallets: [{ currency: 'CNY', balance: '5.00999' }],
    }, 99)).toMatchObject({
      source: 'account',
      status: 'ready',
      balance: {
        total: '25.01',
        granted: '5.01',
        toppedUp: '20.00',
        checkedAt: 99,
      },
    })
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: '3.00',
        granted_balance: '0.00',
        topped_up_balance: '3.00',
      }],
    }), { status: 200 }))
    await expect(loadProviderBalances({
      account: {
        async getBalance() {
          return {
            status: 'failed' as const,
          }
        },
      },
      credentials: {
        async resolve() {
          return { value: 'sk-test' }
        },
      },
      client: { version: '0.2.0', locale: 'zh-CN', timezoneOffsetSeconds: 28800 },
      env: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 7,
    })).resolves.toEqual({
      account: { source: 'account', status: 'unavailable' },
      apiKey: {
        source: 'api-key',
        status: 'ready',
        balance: {
          available: true,
          currency: 'CNY',
          total: '3.00',
          granted: '0.00',
          toppedUp: '3.00',
          checkedAt: 7,
        },
      },
    })
  })

  it('keeps the last proven balance when a refresh fails', async () => {
    let fail = false
    const cache = new BalanceCache(60_000, async () => {
      if (fail) return { status: 'unavailable' as const }
      return {
        status: 'ready' as const,
        balance: {
          available: true,
          currency: 'CNY',
          total: '9.50',
          granted: '0.00',
          toppedUp: '9.50',
          checkedAt: 1,
        },
      }
    }, () => 1000)
    const first = await cache.get(true)
    expect(first).toMatchObject({ status: 'ready', balance: { total: '9.50' } })
    expect(first.balance?.stale).toBeUndefined()
    fail = true
    await expect(cache.get(true)).resolves.toMatchObject({
      status: 'unavailable',
      balance: { total: '9.50', stale: true },
    })
  })
})

describe('model bill history', () => {
  const at = Date.UTC(2026, 8, 1, 9, 0, 0)

  it('reads earlier desktop turns from the session log and keeps a retry as another call', () => {
    const calls = sessionUsageFromEvents([
      {
        type: 'request/header',
        time: at,
        data: {
          header: {
            config: {
              provider: 'deepseek-official',
              model: 'deepseek-v4-pro',
              reasoningEffort: 'high',
            },
          },
        },
      },
      {
        type: 'assistant/message',
        time: at + 1000,
        data: {
          turn: 1,
          step: 0,
          usage: { inputTokens: 4000, outputTokens: 200, cacheReadTokens: 80 },
          message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
        },
      },
      { type: 'llm/retry-started', time: at + 2000, data: { turn: 1, step: 0 } },
      {
        type: 'assistant/attempt',
        time: at + 3000,
        data: {
          turn: 1,
          step: 0,
          stream: [{
            type: 'chunk',
            time: at + 3000,
            chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 5 } },
          }],
        },
      },
      {
        type: 'assistant/message',
        time: at + 4000,
        data: {
          turn: 1,
          step: 0,
          usage: { inputTokens: 21, outputTokens: 6 },
          message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
        },
      },
    ])
    expect(calls.map(call => call.inputTokens)).toEqual([4000, 21])
    expect(calls[0]).toMatchObject({
      source: 'session',
      model: 'deepseek-v4-pro',
      cacheReadTokens: 80,
      reasoningEffort: 'high',
    })
    expect(calls[1]).toMatchObject({ model: 'deepseek-v4-flash', outputTokens: 6 })
  })

  it('does not add a ledger session row that the open conversation already contains', () => {
    const logged = call({ at, source: 'session', inputTokens: 4000, outputTokens: 200, model: 'deepseek-v4-pro' })
    const plugin = call({ at: at + 10, source: 'optimize', inputTokens: 12 })
    const unloaded = call({ at: at + 60_000, source: 'session', inputTokens: 9, outputTokens: 1 })
    const merged = mergeUsageCalls([logged, plugin, unloaded], [logged])
    expect(merged).toEqual([plugin, logged, unloaded])
  })
})

describe('model bill ledger', () => {
  it('persists calls and ignores a corrupt file without throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-usage-'))
    roots.push(root)
    const now = Date.UTC(2026, 10, 3, 8, 0, 0)
    const ledger = new UsageLedger(root)
    ledger.record(call({ at: now, source: 'optimize', inputTokens: 12, outputTokens: 3 }))
    const summary = await ledger.summarize('all', now)
    expect(summary.sources.find(source => source.source === 'optimize')?.inputTokens).toBe(12)
    const saved = JSON.parse(await readFile(join(root, 'ledger.json'), 'utf8')) as { calls: unknown[] }
    expect(saved.calls).toHaveLength(1)

    const reloaded = new UsageLedger(root)
    expect((await reloaded.summarize('all', now)).calls).toBe(1)

    await writeFile(join(root, 'ledger.json'), '{', 'utf8')
    const broken = new UsageLedger(root)
    expect((await broken.summarize('today', now)).calls).toBe(0)
  })

  it('lets only the desktop owner read the bill', async () => {
    const guest = new Context()
    guest.provide('invocation', { peer: { principal: { kind: 'guest' } } } as never)
    const denied = vi.fn(async () => summarizeUsage([], '7d', 0))
    const guestService = new AgentEnhancerService(guest, {} as never, async () => undefined, {
      summarize: denied,
    })
    await expect(guestService.usageSummary('7d')).rejects.toMatchObject({
      code: 'agent-enhancer/forbidden',
    })
    expect(denied).not.toHaveBeenCalled()

    const owner = new Context()
    owner.provide('invocation', { peer: { principal: { kind: 'owner' } } } as never)
    const allowed = vi.fn(async () => summarizeUsage([], '7d', 0))
    const ownerService = new AgentEnhancerService(owner, {} as never, async () => undefined, {
      summarize: allowed,
    })
    await expect(ownerService.usageSummary('7d')).resolves.toMatchObject({ range: '7d', calls: 0 })
    expect(allowed).toHaveBeenCalledWith('7d')
  })
})
