/** Provider-reported token bill. Amounts are tokens, not currency. */

export const USAGE_RANGES = ['today', '7d', '30d', 'all'] as const
export type UsageRange = typeof USAGE_RANGES[number]

export const USAGE_SOURCES = [
  'optimize',
  'predict',
  'compact',
  'autoClassifier',
  'session',
  'compaction',
  'sessionTitle',
  'other',
] as const
export type UsageSource = typeof USAGE_SOURCES[number]

/** Plugin features the user can turn off. Desktop and host calls are the rest. */
export const PLUGIN_USAGE_SOURCES = ['optimize', 'predict', 'compact', 'autoClassifier'] as const
export type PluginUsageSource = typeof PLUGIN_USAGE_SOURCES[number]

export const USAGE_RETENTION_DAYS = 90
export const MAX_USAGE_CALLS = 2000
export const USAGE_RECENT_LIMIT = 40

export interface UsageTokens {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
}

export interface UsageCall extends UsageTokens {
  readonly at: number
  readonly source: UsageSource
  readonly provider: string
  readonly model: string
  /** Effective request effort; empty when the call had none or history omitted it. */
  readonly reasoningEffort: string
}

export interface UsageModelLine extends UsageTokens {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string
  readonly calls: number
}

export interface UsageSourceLine extends UsageTokens {
  readonly source: UsageSource
  readonly calls: number
  readonly models: readonly UsageModelLine[]
}

/** One cell in the bill heatmap: an hour (today) or a calendar day. */
export interface UsageHeatCell {
  readonly key: string
  readonly label: string
  readonly at: number
  readonly tokens: number
  readonly calls: number
}

export type UsageHeatGrain = 'hour' | 'day'

export interface UsageHeatmap {
  readonly grain: UsageHeatGrain
  readonly cells: readonly UsageHeatCell[]
}

/** Local estimate from official price tables — not a provider invoice. */
export interface UsageMoney {
  readonly currency: 'CNY'
  readonly estimatedCost: number
  readonly pricedCalls: number
  readonly unpricedCalls: number
}

/** DeepSeek `/user/balance` snapshot when an API key is available. */
export interface UsageBalance {
  readonly available: boolean
  readonly currency: string
  readonly total: string
  readonly granted: string
  readonly toppedUp: string
  readonly checkedAt: number
  readonly stale?: boolean
}

/** Why balance is or is not shown. Key comes from Desktop credentials, never the plugin. */
export type UsageBalanceStatus = 'ready' | 'no-key' | 'unavailable'

/**
 * Per-provider balance for the Models settings cards.
 * `signed-out` is account-login only; `no-key` is API-key only.
 */
export type ProviderBalanceStatus = 'ready' | 'no-key' | 'signed-out' | 'unavailable'
export type ProviderBalanceSource = 'account' | 'api-key'

export interface ProviderBalanceSnapshot {
  readonly source: ProviderBalanceSource
  readonly status: ProviderBalanceStatus
  readonly balance?: UsageBalance
}

/** Dual-source snapshot for DeepSeek 账号 + DeepSeek API Key rows. */
export interface ProviderBalances {
  readonly account: ProviderBalanceSnapshot
  readonly apiKey: ProviderBalanceSnapshot
}

export interface ProviderBalancesRequest {
  readonly force?: boolean
  /** Active UI locale (e.g. `zh-CN`); Platform maps primary subtag to wire locale. */
  readonly locale?: string
}

export interface UsageSummary extends UsageTokens {
  readonly range: UsageRange
  readonly calls: number
  readonly sources: readonly UsageSourceLine[]
  readonly heatmap: UsageHeatmap
  readonly money: UsageMoney
  /** Kept for wire compat; Models cards own live balance now. */
  readonly balanceStatus: UsageBalanceStatus
  readonly balance?: UsageBalance
  readonly recent: readonly UsageCall[]
}

export interface UsageSummaryReader {
  summarize(range: UsageRange): Promise<UsageSummary>
}
