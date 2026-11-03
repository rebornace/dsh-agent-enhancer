import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AuxiliaryError } from '../errors.ts'
import type { AuxiliaryErrorCode } from '../errors.ts'

export interface ContextCompactRequest {
  readonly sessionId: SessionId
}

export interface ContextCompactResult {
  readonly sessionId: SessionId
  /** Official `/compact` returned a replacement summary. */
  readonly status: 'compacted' | 'noop'
  readonly shadowedCount: number
  readonly shadowedTokens: number
}

export interface CompactRouteOverride {
  readonly provider: string
  readonly model: string
}

/** Minimal face of `@deepseek-ai/dsh-commands` used for `/compact`. */
export interface CompactCommandRuntime {
  execute(
    agent: unknown,
    line: string,
    attachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<{
    readonly result: {
      readonly kind: 'success' | 'error'
      readonly text?: string
    }
  } | undefined>
}

type AgentWithOptions = {
  readonly options?: { provider?: string, model?: string }
  status?: unknown
}

function applyCompactRoute(agent: AgentWithOptions, route: CompactRouteOverride | undefined): (() => void) | undefined {
  if (route === undefined || route.provider === '' || route.model === '') return undefined
  const options = agent.options
  if (options === undefined || typeof options !== 'object') return undefined
  const previous = { provider: options.provider, model: options.model }
  ;(options as { provider?: string, model?: string }).provider = route.provider
  ;(options as { provider?: string, model?: string }).model = route.model
  return () => {
    ;(options as { provider?: string, model?: string }).provider = previous.provider
    ;(options as { provider?: string, model?: string }).model = previous.model
  }
}

function mapCompactErrorText(text: string): AuxiliaryErrorCode {
  const lower = text.toLowerCase()
  if (lower.includes('busy') || lower.includes('active') || text.includes('忙碌')) {
    return 'COMPACT_BUSY'
  }
  if (lower.includes('summary') || text.includes('摘要')) {
    return 'COMPACT_SUMMARY'
  }
  if (lower.includes('changed') || text.includes('已变化') || text.includes('发生变化')) {
    return 'COMPACT_CHANGED'
  }
  if (lower.includes('not available') || text.includes('未提供') || text.includes('不可用')) {
    return 'COMPACT_UNAVAILABLE'
  }
  return 'COMPACT_FAILED'
}

function parseCompactSuccess(sessionId: SessionId, text: string | undefined): ContextCompactResult {
  const body = text ?? ''
  if (/no compactable/i.test(body) || /没有可.*压缩/.test(body)) {
    return {
      sessionId,
      status: 'noop',
      shadowedCount: 0,
      shadowedTokens: 0,
    }
  }
  const countMatch = body.match(/Compacted\s+(\d+)/i) ?? body.match(/已压缩\s*(\d+)/)
  const tokenMatch = body.match(/~\s*(\d+)\s*tokens/i) ?? body.match(/约\s*(\d+)/)
  return {
    sessionId,
    status: 'compacted',
    shadowedCount: countMatch ? Number(countMatch[1]) : 0,
    shadowedTokens: tokenMatch ? Number(tokenMatch[1]) : 0,
  }
}

/**
 * Trigger official idle `/compact` through the command registry — same path as
 * typing `/compact` in chat. Avoids requiring `ctx.compaction` inject (which is
 * not visible in this plugin's Cordis scope on Desktop).
 */
export async function compactContextNow(options: {
  readonly commands: CompactCommandRuntime | undefined
  readonly agent: unknown
  readonly sessionId: SessionId
  readonly signal: AbortSignal
  readonly route?: CompactRouteOverride
}): Promise<ContextCompactResult> {
  options.signal.throwIfAborted()
  if (options.commands === undefined || typeof options.commands.execute !== 'function') {
    throw new AuxiliaryError('COMPACT_UNAVAILABLE')
  }
  if (options.agent === null || typeof options.agent !== 'object') {
    throw new AuxiliaryError('SESSION_CHANGED')
  }
  const agent = options.agent as AgentWithOptions
  if (agent.status !== undefined && agent.status !== 'idle') {
    throw new AuxiliaryError('COMPACT_BUSY')
  }

  const restore = applyCompactRoute(agent, options.route)
  try {
    const execution = await options.commands.execute(agent, '/compact', [], options.signal)
    if (execution === undefined) throw new AuxiliaryError('COMPACT_UNAVAILABLE')
    if (execution.result.kind === 'error') {
      throw new AuxiliaryError(mapCompactErrorText(execution.result.text ?? ''))
    }
    return parseCompactSuccess(options.sessionId, execution.result.text)
  } catch (error) {
    if (options.signal.aborted) throw error
    if (error instanceof AuxiliaryError) throw error
    throw new AuxiliaryError('COMPACT_FAILED')
  } finally {
    restore?.()
  }
}
