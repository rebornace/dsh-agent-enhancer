import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CheckpointServiceSession } from './service.ts'

type LiveAgent = NonNullable<ReturnType<Context['agents']['get']>>

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
      runMaintenance: task => agent.runMaintenance(task),
      synchronize: async signal => {
        signal.throwIfAborted()
        this.ctx.sessionProjections.snapshot(agent.session)
        await (this.ctx.get('sessions') as unknown as SessionStore).flush(agent.session)
        signal.throwIfAborted()
      },
    }
    this.adapters.set(sessionId, { agent, adapter })
    return adapter
  }
}
