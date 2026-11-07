import type { Context } from '@deepseek-ai/cordis'
import type { SoftPauseGate } from './gate.ts'

export interface SoftPauseLiveOptions {
  readonly gate: SoftPauseGate
  readonly enabled: () => boolean
}

/**
 * Hold the next model step while the session gate is engaged.
 * Coexists with checkpoint / auto-route `agent/pre-step` hooks via `await next()`.
 */
export function installSoftPause(ctx: Context, options: SoftPauseLiveOptions): void {
  ctx.on('agent/pre-step', async (payload, next) => {
    if (!options.enabled()) return await next()
    const sessionId = payload.agent.session.id
    await options.gate.waitIfEngaged(sessionId, payload.signal)
    if (payload.signal.aborted) return { kind: 'reject' as const }
    return await next()
  })
}
