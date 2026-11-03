import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { AssistantStreamRecord, TokenUsage } from '@deepseek-ai/dsh-llm'
import { usageCallFromReport } from './summarize.ts'
import type { UsageCall } from './types.ts'

/** Ledger rows and log rows for the same call can land a few minutes apart. */
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000

export interface ReadableSessionEvent {
  readonly type: string
  readonly time: number
  readonly data: unknown
}

interface Route {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string
}

function record(value: unknown): { readonly [key: string]: unknown } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return value as { readonly [key: string]: unknown }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function routeOf(provider: unknown, model: unknown, reasoningEffort: unknown = ''): Route | undefined {
  const nextProvider = text(provider)?.trim() ?? ''
  const nextModel = text(model)?.trim() ?? ''
  if (nextProvider === '' || nextModel === '') return undefined
  return {
    provider: nextProvider,
    model: nextModel,
    reasoningEffort: typeof reasoningEffort === 'string' ? reasoningEffort.trim() : '',
  }
}

function optionalCount(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined
  return value
}

function tokenUsage(value: unknown): TokenUsage | undefined {
  const data = record(value)
  if (data === undefined) return undefined
  const inputTokens = optionalCount(data.inputTokens)
  const outputTokens = optionalCount(data.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const usage: TokenUsage = { inputTokens, outputTokens }
  const totalTokens = optionalCount(data.totalTokens)
  const cacheReadTokens = optionalCount(data.cacheReadTokens)
  const cacheWriteTokens = optionalCount(data.cacheWriteTokens)
  const reasoningTokens = optionalCount(data.reasoningTokens)
  if (data.totalTokens !== undefined && totalTokens === undefined) return undefined
  if (data.cacheReadTokens !== undefined && cacheReadTokens === undefined) return undefined
  if (data.cacheWriteTokens !== undefined && cacheWriteTokens === undefined) return undefined
  if (data.reasoningTokens !== undefined && reasoningTokens === undefined) return undefined
  if (totalTokens !== undefined) usage.totalTokens = totalTokens
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens
  return usage
}

function streamUsage(value: unknown): TokenUsage | undefined {
  if (!Array.isArray(value)) return undefined
  try {
    return lastAssistantStreamChunk(value as readonly AssistantStreamRecord[], 'usage')?.usage
  } catch {
    return undefined
  }
}

function messageRoute(value: unknown, fallbackEffort = ''): Route | undefined {
  const message = record(value)
  const source = record(message?.source)
  if (source?.kind !== 'model') return undefined
  return routeOf(
    source.provider,
    source.model,
    source.reasoningEffort ?? fallbackEffort,
  )
}

function sameCall(left: UsageCall, right: UsageCall): boolean {
  // Effort may be missing on older ledger rows or log samples; still match the
  // same attempt when the rest of the bill fingerprint agrees.
  const effortCompatible = left.reasoningEffort === right.reasoningEffort
    || left.reasoningEffort === ''
    || right.reasoningEffort === ''
  return left.source === right.source
    && left.provider === right.provider
    && left.model === right.model
    && effortCompatible
    && left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
    && left.reasoningTokens === right.reasoningTokens
    && Math.abs(left.at - right.at) <= DUPLICATE_WINDOW_MS
}

function callKey(call: UsageCall): string {
  return [
    call.at,
    call.source,
    call.provider,
    call.model,
    call.reasoningEffort,
    call.inputTokens,
    call.outputTokens,
    call.cacheReadTokens,
    call.cacheWriteTokens,
    call.reasoningTokens,
  ].join('\0')
}

/**
 * Desktop session tokens from a conversation log.
 * `assistant/message` replaces the same attempt's stream sample.
 * `llm/retry` starts another billed attempt. Inherited copies of the same
 * event are collapsed when several live sessions are folded together.
 */
export function sessionUsageFromEvents(events: readonly ReadableSessionEvent[]): UsageCall[] {
  let route: Route | undefined
  let generation = 0
  const calls: UsageCall[] = []
  const slot = new Map<string, number>()

  const upsert = (
    turn: number,
    step: number,
    usage: TokenUsage | undefined,
    at: number,
    messageRouteValue: Route | undefined,
  ) => {
    const chosen = messageRouteValue ?? route
    if (usage === undefined || chosen === undefined) return
    const call = usageCallFromReport(
      'session',
      chosen.provider,
      chosen.model,
      usage,
      at,
      chosen.reasoningEffort,
    )
    if (call === undefined) return
    const key = `${turn}:${step}:${generation}`
    const index = slot.get(key)
    if (index === undefined) {
      slot.set(key, calls.length)
      calls.push(call)
    } else {
      // Prefer a later sample that still carries effort when the earlier one
      // omitted it (stream usage before the header-resolved route landed).
      const previous = calls[index]!
      calls[index] = call.reasoningEffort === '' && previous.reasoningEffort !== ''
        ? { ...call, reasoningEffort: previous.reasoningEffort }
        : call
    }
  }

  for (const event of events) {
    if (event.type === 'request/header') {
      const header = record(record(event.data)?.header)
      const config = record(header?.config)
      const next = routeOf(config?.provider, config?.model, config?.reasoningEffort)
      if (next !== undefined) route = next
      continue
    }
    if (event.type === 'request/context') {
      const data = record(event.data)
      const next = routeOf(data?.provider, data?.model, data?.reasoningEffort)
      if (next !== undefined) route = next
      continue
    }
    if (event.type === 'llm/retry' || event.type === 'llm/retry-started') {
      generation += 1
      continue
    }
    if (event.type === 'assistant/attempt') {
      const data = record(event.data)
      const turn = data?.turn
      const step = data?.step
      if (typeof turn !== 'number' || typeof step !== 'number') continue
      upsert(turn, step, streamUsage(data?.stream), event.time, undefined)
      continue
    }
    if (event.type === 'assistant/message') {
      const data = record(event.data)
      const turn = data?.turn
      const step = data?.step
      if (typeof turn !== 'number' || typeof step !== 'number') continue
      const usage = tokenUsage(data?.usage) ?? streamUsage(data?.stream)
      upsert(
        turn,
        step,
        usage,
        event.time,
        messageRoute(data?.message, route?.reasoningEffort ?? ''),
      )
    }
  }
  return calls
}

export function sessionUsageFromSessions(
  sessions: readonly { snapshotEvents(): readonly ReadableSessionEvent[] }[],
): UsageCall[] {
  const seen = new Set<string>()
  const calls: UsageCall[] = []
  for (const session of sessions) {
    let events: readonly ReadableSessionEvent[]
    try {
      events = session.snapshotEvents()
    } catch {
      continue
    }
    for (const call of sessionUsageFromEvents(events)) {
      const key = callKey(call)
      if (seen.has(key)) continue
      seen.add(key)
      calls.push(call)
    }
  }
  return calls
}

/**
 * Session rows in the ledger repeat calls that are already in an open
 * conversation log. Keep a ledger session row only when the log has no match,
 * so an unloaded session is not dropped and a loaded one is not counted twice.
 */
export function mergeUsageCalls(
  stored: readonly UsageCall[],
  history: readonly UsageCall[],
): UsageCall[] {
  const unmatched = stored.filter(call => call.source === 'session')
  const rest = stored.filter(call => call.source !== 'session')
  for (const call of history) {
    const index = unmatched.findIndex(item => sameCall(item, call))
    if (index >= 0) unmatched.splice(index, 1)
  }
  return [...rest, ...history, ...unmatched]
}
