import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { deriveMessagesWithCut } from './cut-filter.ts'
import type { SessionCut, SessionCutStore } from './cut-store.ts'

type LiveAgent = NonNullable<ReturnType<Context['agents']['get']>>

/**
 * Patch Session.deriveMessages so withdrawn turns never reach the model prompt.
 * Chat transcript filtering is client-side and uses the same cut cache.
 */
export function installSessionCutFilter(
  ctx: Context,
  options: {
    readonly store: SessionCutStore
    readonly cache: Map<SessionId, SessionCut | null>
  },
): () => void {
  const patched = new WeakSet<object>()

  const patchSession = (session: Session) => {
    if (patched.has(session)) return
    patched.add(session)
    const native = session.deriveMessages.bind(session)
    session.deriveMessages = () => {
      const cut = options.cache.get(session.id)
      if (cut === undefined || cut === null) return native()
      return deriveMessagesWithCut(session, cut)
    }
  }

  const warm = async (sessionId: SessionId) => {
    if (options.cache.has(sessionId)) return
    const cut = await options.store.get(sessionId)
    options.cache.set(sessionId, cut)
  }

  const disposers: Array<() => void> = []
  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload.agent as LiveAgent
    patchSession(agent.session)
    await warm(agent.session.id)
    return next()
  }))

  const agents = ctx.agents
  if (agents !== undefined && typeof agents.get === 'function') {
    const inner = agents.get.bind(agents)
    agents.get = ((id: SessionId) => {
      const agent = inner(id)
      if (agent?.session !== undefined) {
        patchSession(agent.session)
        void warm(agent.session.id as SessionId)
      }
      return agent
    }) as typeof agents.get
    disposers.push(() => {
      if (agents.get !== inner) agents.get = inner
    })
  }

  return () => {
    while (disposers.length > 0) disposers.pop()?.()
  }
}

export function syncCutCache(
  cache: Map<SessionId, SessionCut | null>,
  sessionId: SessionId,
  cut: SessionCut | null,
): void {
  cache.set(sessionId, cut)
}
