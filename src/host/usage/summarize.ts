import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  MAX_USAGE_CALLS,
  PLUGIN_USAGE_SOURCES,
  USAGE_RECENT_LIMIT,
  USAGE_RETENTION_DAYS,
  USAGE_SOURCES,
} from './types.ts'
import { summarizeMoney } from './pricing.ts'
import type {
  UsageCall,
  UsageHeatCell,
  UsageHeatmap,
  UsageModelLine,
  UsageRange,
  UsageSource,
  UsageSourceLine,
  UsageSummary,
  UsageTokens,
} from './types.ts'

const RETENTION_MS = USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DESKTOP_SOURCES = ['session', 'compaction', 'sessionTitle', 'other'] as const

const EMPTY_TOKENS: UsageTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
}

function tokenCount(value: number | undefined): number | undefined {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) return undefined
  return value
}

export function normalizeReasoningEffort(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim()
}

export function usageCallFromReport(
  source: UsageSource,
  provider: string,
  model: string,
  usage: TokenUsage,
  at: number,
  reasoningEffort: string = '',
): UsageCall | undefined {
  if (!Number.isSafeInteger(at) || at < 0) return undefined
  if (!USAGE_SOURCES.includes(source)) return undefined
  const inputTokens = tokenCount(usage.inputTokens)
  const outputTokens = tokenCount(usage.outputTokens)
  const cacheReadTokens = tokenCount(usage.cacheReadTokens)
  const cacheWriteTokens = tokenCount(usage.cacheWriteTokens)
  const reasoningTokens = tokenCount(usage.reasoningTokens)
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || cacheReadTokens === undefined
    || cacheWriteTokens === undefined
    || reasoningTokens === undefined
  ) return undefined
  const routeProvider = provider.trim()
  const routeModel = model.trim()
  if (routeProvider === '' || routeModel === '') return undefined
  return {
    at,
    source,
    provider: routeProvider,
    model: routeModel,
    reasoningEffort: normalizeReasoningEffort(reasoningEffort),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  }
}

export function retainUsageCalls(calls: readonly UsageCall[], now: number): UsageCall[] {
  const cutoff = now - RETENTION_MS
  return calls
    .filter(call => call.at >= cutoff)
    .sort((left, right) => left.at - right.at)
    .slice(-MAX_USAGE_CALLS)
}

function rangeStart(range: UsageRange, now: number): number {
  switch (range) {
    case 'today': {
      const date = new Date(now)
      date.setHours(0, 0, 0, 0)
      return date.getTime()
    }
    case '7d':
      return now - 7 * DAY_MS
    case '30d':
      return now - 30 * DAY_MS
    case 'all':
      return 0
    default: {
      const _exhaustive: never = range
      return _exhaustive
    }
  }
}

function add(tokens: UsageTokens, call: UsageTokens): UsageTokens {
  return {
    inputTokens: tokens.inputTokens + call.inputTokens,
    outputTokens: tokens.outputTokens + call.outputTokens,
    cacheReadTokens: tokens.cacheReadTokens + call.cacheReadTokens,
    cacheWriteTokens: tokens.cacheWriteTokens + call.cacheWriteTokens,
    reasoningTokens: tokens.reasoningTokens + call.reasoningTokens,
  }
}

function volume(tokens: UsageTokens): number {
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
}

function startOfLocalDay(at: number): Date {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function dayKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function hourKey(at: number): string {
  const date = new Date(at)
  return `${dayKey(at)}T${pad2(date.getHours())}`
}

function dayLabel(at: number): string {
  const date = new Date(at)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function hourLabel(at: number): string {
  return `${pad2(new Date(at).getHours())}`
}

function buildHeatmap(calls: readonly UsageCall[], range: UsageRange, now: number): UsageHeatmap {
  if (range === 'today') {
    const dayStart = startOfLocalDay(now).getTime()
    const buckets = new Map<string, UsageHeatCell>()
    for (let hour = 0; hour < 24; hour += 1) {
      const at = dayStart + hour * 60 * 60 * 1000
      const key = hourKey(at)
      buckets.set(key, { key, label: hourLabel(at), at, tokens: 0, calls: 0 })
    }
    for (const call of calls) {
      if (call.at < dayStart || call.at > now) continue
      const key = hourKey(call.at)
      const cell = buckets.get(key)
      if (cell === undefined) continue
      buckets.set(key, {
        ...cell,
        tokens: cell.tokens + volume(call),
        calls: cell.calls + 1,
      })
    }
    return { grain: 'hour', cells: [...buckets.values()] }
  }

  const dayCount = range === '7d' ? 7 : range === '30d' ? 30 : USAGE_RETENTION_DAYS
  const endDay = startOfLocalDay(now)
  const buckets = new Map<string, UsageHeatCell>()
  for (let offset = dayCount - 1; offset >= 0; offset -= 1) {
    const at = endDay.getTime() - offset * DAY_MS
    const key = dayKey(at)
    buckets.set(key, { key, label: dayLabel(at), at, tokens: 0, calls: 0 })
  }
  for (const call of calls) {
    const key = dayKey(call.at)
    const cell = buckets.get(key)
    if (cell === undefined) continue
    buckets.set(key, {
      ...cell,
      tokens: cell.tokens + volume(call),
      calls: cell.calls + 1,
    })
  }
  return { grain: 'day', cells: [...buckets.values()] }
}

function sourceLine(source: UsageSource, calls: readonly UsageCall[]): UsageSourceLine {
  const models = new Map<string, UsageModelLine>()
  let totals: UsageTokens = EMPTY_TOKENS
  for (const call of calls) {
    totals = add(totals, call)
    const key = `${call.provider}\0${call.model}\0${call.reasoningEffort}`
    const current = models.get(key)
    if (current === undefined) {
      models.set(key, {
        provider: call.provider,
        model: call.model,
        reasoningEffort: call.reasoningEffort,
        calls: 1,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        cacheReadTokens: call.cacheReadTokens,
        cacheWriteTokens: call.cacheWriteTokens,
        reasoningTokens: call.reasoningTokens,
      })
    } else {
      const nextTokens = add(current, call)
      models.set(key, { ...current, ...nextTokens, calls: current.calls + 1 })
    }
  }
  const modelLines = [...models.values()].sort((left, right) => {
    const delta = volume(right) - volume(left)
    if (delta !== 0) return delta
    const provider = left.provider.localeCompare(right.provider)
    if (provider !== 0) return provider
    const model = left.model.localeCompare(right.model)
    if (model !== 0) return model
    return left.reasoningEffort.localeCompare(right.reasoningEffort)
  })
  return { source, calls: calls.length, ...totals, models: modelLines }
}

export function summarizeUsage(
  calls: readonly UsageCall[],
  range: UsageRange,
  now: number,
): UsageSummary {
  const start = rangeStart(range, now)
  const selected = calls.filter(call => call.at >= start && call.at <= now)
  const bySource = new Map<UsageSource, UsageCall[]>()
  for (const source of USAGE_SOURCES) bySource.set(source, [])
  for (const call of selected) bySource.get(call.source)?.push(call)

  const sources: UsageSourceLine[] = []
  for (const source of PLUGIN_USAGE_SOURCES) {
    sources.push(sourceLine(source, bySource.get(source) ?? []))
  }
  for (const source of DESKTOP_SOURCES) {
    const group = bySource.get(source) ?? []
    if (group.length > 0) sources.push(sourceLine(source, group))
  }

  let totals: UsageTokens = EMPTY_TOKENS
  for (const call of selected) totals = add(totals, call)
  const recent = [...selected].sort((left, right) => right.at - left.at).slice(0, USAGE_RECENT_LIMIT)
  return {
    range,
    calls: selected.length,
    ...totals,
    sources,
    heatmap: buildHeatmap(selected, range, now),
    money: summarizeMoney(selected),
    // Live balance lives on Models provider cards; bill keeps estimate only.
    balanceStatus: 'no-key',
    recent,
  }
}
