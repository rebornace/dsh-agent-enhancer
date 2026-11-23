import type { Context } from '@deepseek-ai/cordis'
import type { SoftPauseGate } from './gate.ts'
import { sessionLineage, sessionStore } from './lineage.ts'
import type { SessionLike } from './lineage.ts'

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
    const session = payload.agent.session as unknown as SessionLike
    const own = session.header?.id ?? session.id
    const owners = sessionLineage(session, sessionStore(ctx)).filter(id => options.gate.isEngaged(id))
    if (owners.length === 0) return await next()
    // A stopped turn drops its own pause; a subagent step must not drop an
    // ancestor's, or aborting the child would silently resume the parent.
    await options.gate.waitWhileEngaged(
      owners,
      payload.signal,
      own !== undefined && owners.includes(own) ? { clearOnAbort: own } : {},
    )
    if (payload.signal.aborted) return { kind: 'reject' as const }
    return await next()
  })
}
