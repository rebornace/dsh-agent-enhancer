import type { UsageCall } from './types.ts'

/** Unit prices in currency per 1M tokens. */
export interface UnitPrice {
  readonly input: number
  readonly cacheRead: number
  readonly output: number
}

export interface ModelPriceRow {
  readonly input: number
  readonly cacheRead: number
  readonly output: number
}

export type ModelPriceTable = Readonly<Record<string, ModelPriceRow>>

export interface FlatPricingPolicy {
  readonly since: string
  readonly label: string
  readonly prices: ModelPriceTable
}

export interface PeakPricingPolicy {
  readonly since: string
  readonly label: string
  readonly peak: ModelPriceTable
  readonly offPeak: ModelPriceTable
}

export type PricingPolicy = FlatPricingPolicy | PeakPricingPolicy

export const DEFAULT_TIMEZONE = 'Asia/Shanghai'
/** Peak windows in local hours, half-open [start, end). */
export const DEFAULT_PEAK_WINDOWS: readonly (readonly [number, number])[] = [
  [9, 12],
  [14, 18],
]

/**
 * Official DeepSeek CNY policy timeline (¥ / 1M tokens).
 * Curated from https://api-docs.deepseek.com/zh-cn/quick_start/pricing —
 * peak/off-peak from 2026-08-17; Flash V4.1 rates from 2026-09-10.
 * Weekend / Chinese-holiday full-day off-peak: weekends enforced; holidays
 * still follow weekday peak windows until a holiday calendar is added.
 */
export const DEEPSEEK_PRICING_POLICIES: readonly PricingPolicy[] = [
  {
    since: '2025-02-09T00:00:00+08:00',
    label: 'deepseek-chat / deepseek-reasoner',
    prices: {
      'deepseek-chat': { input: 2, cacheRead: 0.5, output: 8 },
      'deepseek-reasoner': { input: 4, cacheRead: 1, output: 16 },
    },
  },
  {
    since: '2026-05-22T00:00:00+08:00',
    label: 'V4 flat pricing',
    prices: {
      'deepseek-v4-flash': { input: 1, cacheRead: 0.02, output: 2 },
      'deepseek-flash': { input: 1, cacheRead: 0.02, output: 2 },
      'deepseek-v4-pro': { input: 3, cacheRead: 0.025, output: 6 },
    },
  },
  {
    since: '2026-08-17T00:00:00+08:00',
    label: 'V4 peak / off-peak',
    peak: {
      'deepseek-v4-flash': { input: 3, cacheRead: 0.1, output: 9 },
      'deepseek-flash': { input: 3, cacheRead: 0.1, output: 9 },
      'deepseek-v4-pro': { input: 9, cacheRead: 0.3, output: 27 },
    },
    offPeak: {
      'deepseek-v4-flash': { input: 1.5, cacheRead: 0.05, output: 4.5 },
      'deepseek-flash': { input: 1.5, cacheRead: 0.05, output: 4.5 },
      'deepseek-v4-pro': { input: 4.5, cacheRead: 0.15, output: 13.5 },
    },
  },
  {
    since: '2026-09-10T00:00:00+08:00',
    label: 'V4.1 Flash + Pro peak / off-peak (current docs)',
    peak: {
      'deepseek-v4-flash': { input: 2, cacheRead: 0.04, output: 8 },
      'deepseek-flash': { input: 2, cacheRead: 0.04, output: 8 },
      'deepseek-v4-pro': { input: 9, cacheRead: 0.3, output: 27 },
    },
    offPeak: {
      'deepseek-v4-flash': { input: 1, cacheRead: 0.02, output: 4 },
      'deepseek-flash': { input: 1, cacheRead: 0.02, output: 4 },
      'deepseek-v4-pro': { input: 4.5, cacheRead: 0.15, output: 13.5 },
    },
  },
]

/** Normalize model ids so legacy flash names share one price row. */
export function normalizePricedModel(model: string): string {
  const trimmed = model.trim().toLowerCase()
  if (
    trimmed === 'deepseek-v4-flash'
    || trimmed === 'deepseek-flash'
    || trimmed === 'deepseek-v4-flash-vision-exp'
  ) {
    return 'deepseek-flash'
  }
  return trimmed
}

function isPeakPolicy(policy: PricingPolicy): policy is PeakPricingPolicy {
  return 'peak' in policy && 'offPeak' in policy
}

export function activePolicy(
  timeMs: number,
  policies: readonly PricingPolicy[] = DEEPSEEK_PRICING_POLICIES,
): PricingPolicy | undefined {
  let active: PricingPolicy | undefined
  for (const policy of policies) {
    const since = Date.parse(policy.since)
    if (Number.isFinite(since) && timeMs >= since) active = policy
  }
  return active ?? policies[0]
}

/**
 * Peak hours on Beijing weekdays only. Official rule also excludes Chinese
 * public holidays; those still use weekday peak windows here.
 */
export function isPeakTime(
  timeMs: number,
  timezone = DEFAULT_TIMEZONE,
  windows: readonly (readonly [number, number])[] = DEFAULT_PEAK_WINDOWS,
): boolean {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      weekday: 'short',
      hour: 'numeric',
    }).formatToParts(new Date(timeMs))
    const weekday = parts.find(part => part.type === 'weekday')?.value ?? ''
    if (weekday === 'Sat' || weekday === 'Sun') return false
    const hour = Number(parts.find(part => part.type === 'hour')?.value ?? '-1') % 24
    if (!Number.isFinite(hour) || hour < 0) return false
    return windows.some(([start, end]) => hour >= start && hour < end)
  } catch {
    return false
  }
}

function lookupRow(table: ModelPriceTable, model: string): ModelPriceRow | undefined {
  return table[model] ?? table[normalizePricedModel(model)]
}

/** Resolve CNY unit prices for a model at an instant, or undefined if unpriced. */
export function unitPriceAt(
  model: string,
  timeMs: number,
  policies: readonly PricingPolicy[] = DEEPSEEK_PRICING_POLICIES,
): UnitPrice | undefined {
  const policy = activePolicy(timeMs, policies)
  if (policy === undefined) return undefined
  const key = normalizePricedModel(model)
  if (isPeakPolicy(policy)) {
    const table = isPeakTime(timeMs) ? policy.peak : policy.offPeak
    return lookupRow(table, key)
  }
  return lookupRow(policy.prices, key)
}

/** Cost in CNY for one ledger call, or null when the model has no price row. */
export function estimateCallCost(
  call: Pick<UsageCall, 'at' | 'model' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>,
  policies: readonly PricingPolicy[] = DEEPSEEK_PRICING_POLICIES,
): number | null {
  const unit = unitPriceAt(call.model, call.at, policies)
  if (unit === undefined) return null
  const perMillion = 1_000_000
  return (
    (call.inputTokens / perMillion) * unit.input
    + (call.cacheReadTokens / perMillion) * unit.cacheRead
    + (call.outputTokens / perMillion) * unit.output
  )
}

export function summarizeMoney(
  calls: readonly Pick<UsageCall, 'at' | 'model' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>[],
  policies: readonly PricingPolicy[] = DEEPSEEK_PRICING_POLICIES,
): { currency: 'CNY', estimatedCost: number, pricedCalls: number, unpricedCalls: number } {
  let estimatedCost = 0
  let pricedCalls = 0
  let unpricedCalls = 0
  for (const call of calls) {
    const cost = estimateCallCost(call, policies)
    if (cost === null) {
      unpricedCalls += 1
      continue
    }
    pricedCalls += 1
    estimatedCost += cost
  }
  return {
    currency: 'CNY',
    estimatedCost: Number.isFinite(estimatedCost) && estimatedCost >= 0 ? estimatedCost : 0,
    pricedCalls,
    unpricedCalls,
  }
}
