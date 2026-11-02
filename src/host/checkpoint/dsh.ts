import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CheckpointServiceSession } from './service.ts'

type LiveAgent = NonNullable<ReturnType<Context['agents']['get']>>

type IdlePhaseAgent = LiveAgent & {
  phase?: { kind: string, lastTurn?: number }
  setPhase?(phase: { kind: 'idle', lastTurn: number }): void
}

/**
 * `Agent.runMaintenance` freezes `phase.lastTurn` for the whole job and restores
 * it afterward. Undo appends a fresh `turn/start` inside that job, so the
 * turnBoundary projection advances while the Agent still believes the older
 * lastTurn — the next user prompt then reopens the undo shell's turn id and
 * Chat's by-turn index collapses the restored reply. Re-sync from the
 * projection once maintenance releases the Agent.
 */
function syncIdleLastTurnFromProjection(ctx: Context, agent: LiveAgent): void {
  if (agent.status !== 'idle') return
  const lastTurn = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')?.lastTurn
  if (typeof lastTurn !== 'number') return
  const live = agent as IdlePhaseAgent
  if (live.phase?.kind !== 'idle' || live.phase.lastTurn === lastTurn) return
  if (typeof live.setPhase === 'function') {
    live.setPhase({ kind: 'idle', lastTurn })
    return
  }
  live.phase = { kind: 'idle', lastTurn }
}

export class DshCheckpointSessions {
  private readonly adapters = new Map<SessionId, { agent: LiveAgent, adapter: CheckpointServiceSession }>()

  constructor(private readonly ctx: Context) {}

  resolveSession = (sessionId: SessionId): CheckpointServiceSession | undefined => {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined || (this.ctx.get('sessions') as unknown as SessionStore).get(sessionId) !== agent.session) {
      this.adapters.delete(sessionId)
      return undefined
    }
    const cached = this.adapters.get(sessionId)
    if (cached?.agent === agent) return cached.adapter
    const workspaceRoot = agent.session.header.cwd ?? ''
    const adapter: CheckpointServiceSession = {
      session: agent.session,
      workspaceRoot,
      get status() { return agent.status },
      get canRestore() { return workspaceRoot !== '' },
      readEvents: () => agent.session.snapshotEvents(),
      runMaintenance: async task => {
        const result = await agent.runMaintenance(task)
        syncIdleLastTurnFromProjection(this.ctx, agent)
        return result
      },
      synchronize: async signal => {
        signal.throwIfAborted()
        // Drive projections from the in-memory append, persist, then re-read so
        // client views observe the committed surface before execute returns.
        // flush() === false means the Session was already durable (common during
        // startup journal recovery); only a thrown error is a real sync failure.
        this.ctx.sessionProjections.snapshot(agent.session)
        await (this.ctx.get('sessions') as unknown as SessionStore).flush(agent.session)
        signal.throwIfAborted()
        this.ctx.sessionProjections.snapshot(agent.session)
      },
    }
    this.adapters.set(sessionId, { agent, adapter })
    return adapter
  }
}
