import { AsyncLocalStorage } from 'node:async_hooks'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { PluginUsageSource, UsageSource } from './types.ts'

const storage = new AsyncLocalStorage<PluginUsageSource>()

/**
 * Stamps the concrete GenerateOptions object so attribution survives Cordis
 * waterfall / async-generator boundaries where AsyncLocalStorage can drop.
 */
const stamps = new WeakMap<object, PluginUsageSource>()

export function withUsageSource<T>(source: PluginUsageSource, run: () => T): T {
  return storage.run(source, run)
}

export function stampUsageSource(options: object, source: PluginUsageSource): void {
  stamps.set(options, source)
}

/**
 * Attribute one model call.
 * An explicit plugin stamp or ALS scope wins, including when that call is
 * official compaction triggered from the plugin. Otherwise the request's own
 * purpose or the agent loop mark decides. A loop-shaped call that was not
 * marked still counts as a desktop session when it carries a session id and
 * no one-shot system prompt.
 */
export function classifyUsageSource(options: GenerateOptions): UsageSource {
  const stamped = stamps.get(options)
  if (stamped !== undefined) return stamped
  const tagged = storage.getStore()
  if (tagged !== undefined) {
    stamps.set(options, tagged)
    return tagged
  }
  switch (options.purpose) {
    case 'compaction':
      return 'compaction'
    case 'session-title':
      return 'sessionTitle'
    case undefined:
      break
    default: {
      const _exhaustive: never = options.purpose
      void _exhaustive
      return 'other'
    }
  }
  if (isAgentLoopRequest(options)) return 'session'
  if (options.system === undefined && options.sessionId !== undefined) return 'session'
  return 'other'
}
