import type { Context } from '@deepseek-ai/cordis'
import type { SoftPauseGate } from './gate.ts'

export interface SoftPauseLiveOptions {
  readonly gate: SoftPauseGate
  readonly enabled: () => boolean
}

interface SessionHeaderLike {
  readonly id: string
  readonly origin?: string
  readonly parentSession?: string
}

interface SessionLike {
  readonly id?: string
  readonly header?: SessionHeaderLike
}

interface SessionStoreLike {
  get(id: string): SessionLike | undefined
}

/**
 * The agent's own session id, then its subagent ancestors.
 *
 * A subagent runs as its own Session (`header.parentSession`), so a gate that
 * only compared `payload.agent.session.id` let a paused session keep spending:
 * the child stepped while the parent was parked. Walking the lineage is the
 * same rule the official archived-session gate applies — a *fork* keeps the
 * source id in `parentSession` but is an independent conversation, so only
 * `origin === 'subagent'` continues the walk.
 */
function parentHeader(sessions: SessionStoreLike | undefined, id: string): SessionHeaderLike | undefined {
  try {
    return sessions?.get(id)?.header
  } catch {
    // A store that refuses the id must not break the step; stop the walk.
    return undefined
  }
}

export function sessionLineage(session: SessionLike, sessions: SessionStoreLike | undefined): string[] {
  const ids: string[] = []
  const visited = new Set<string>()
  let id = session.header?.id ?? session.id
  let header = session.header
  while (id !== undefined && !visited.has(id)) {
    visited.add(id)
    ids.push(id)
    if (header === undefined) break
    if (header.origin !== 'subagent' || header.parentSession === undefined) break
    id = header.parentSession
    header = parentHeader(sessions, id)
  }
  return ids
}

function sessionStore(ctx: Context): SessionStoreLike | undefined {
  try {
    return ctx.get('sessions') as SessionStoreLike | undefined
  } catch {
    return undefined
  }
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
