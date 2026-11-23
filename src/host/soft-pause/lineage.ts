import type { Context } from '@deepseek-ai/cordis'

/** Header fields a subagent Session carries; forks keep `parentSession` but not `origin`. */
export interface SessionHeaderLike {
  readonly id: string
  readonly origin?: string
  readonly parentSession?: string
}

export interface SessionLike {
  readonly id?: string
  readonly header?: SessionHeaderLike
}

export interface SessionStoreLike {
  get(id: string): SessionLike | undefined
}

export interface AgentLike {
  readonly status?: string
  readonly session?: SessionLike
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

function parentHeader(sessions: SessionStoreLike | undefined, id: string): SessionHeaderLike | undefined {
  try {
    return sessions?.get(id)?.header
  } catch {
    // A store that refuses the id must not break the step; stop the walk.
    return undefined
  }
}

/**
 * Whether live work is running anywhere in this session's tree.
 *
 * The pause control used to require the session's *own* turn to be running,
 * which left no way to stop a delegation: the parent hands off in seconds and
 * the child keeps spending while the bubble shows no button. A subagent can
 * outlive the turn that spawned it, so the tree — not the turn — is what the
 * control has to watch.
 */
export function isTreeRunning(
  rootSessionId: string,
  agents: readonly AgentLike[],
  sessions: SessionStoreLike | undefined,
): boolean {
  for (const agent of agents) {
    if (agent.status !== 'running') continue
    if (agent.session === undefined) continue
    if (sessionLineage(agent.session, sessions).includes(rootSessionId)) return true
  }
  return false
}

/** The host's Session store, when the composition provides one. */
export function sessionStore(ctx: Context): SessionStoreLike | undefined {
  try {
    return ctx.get('sessions') as SessionStoreLike | undefined
  } catch {
    return undefined
  }
}
