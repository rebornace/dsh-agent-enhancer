import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { activeRollbackUndoTip, presentRollbackTranscript } from './transcript.ts'
import type { RollbackUndoTipStore } from './undo-tip.ts'

interface EventSource {
  getSnapshot(): { entries: readonly SessionEventLikeEntry[], hasMore: boolean, revision: number }
  subscribe(listener: () => void): () => void
  replace?(entries: readonly SessionEventLikeEntry[], hasMore?: boolean): void
}

interface SessionBinding {
  readonly eventSource: EventSource
}

interface SessionsService {
  list: { getSnapshot(): { ids: readonly SessionId[] }, subscribe(listener: () => void): () => void }
  binding(id: SessionId): SessionBinding | undefined
  retainInfo(id: SessionId): { subscribe(listener: () => void): () => void }
}

/**
 * Keep Chat's loaded window aligned with rollback surface semantics without
 * rewriting the Host append-only log. Also refreshes the session undo tip used
 * by the composer + / command menu.
 */
export function installRollbackTranscriptFilter(
  ctx: Context,
  tips?: RollbackUndoTipStore,
): () => void {
  const sessions = ctx.get('sessions') as SessionsService | undefined
  if (sessions?.list === undefined || typeof sessions.binding !== 'function') return () => {}

  const watched = new Map<SessionId, () => void>()
  const syncSession = (sessionId: SessionId) => {
    const binding = sessions.binding(sessionId)
    const source = binding?.eventSource
    if (source?.replace === undefined) {
      tips?.set(sessionId, undefined)
      return
    }
    const window = source.getSnapshot()
    const presented = presentRollbackTranscript(window.entries)
    tips?.set(sessionId, activeRollbackUndoTip(presented)?.turn)
    if (presented !== window.entries) source.replace(presented, window.hasMore)
  }

  const watch = (sessionId: SessionId) => {
    if (watched.has(sessionId)) return
    const binding = sessions.binding(sessionId)
    if (binding === undefined) return
    const source = binding.eventSource
    const retention = sessions.retainInfo?.(sessionId)
    const unsubSource = source.subscribe(() => { syncSession(sessionId) })
    const unsubRetention = retention?.subscribe(() => {
      if (sessions.binding(sessionId) === undefined) {
        watched.get(sessionId)?.()
        watched.delete(sessionId)
        tips?.set(sessionId, undefined)
      }
    }) ?? (() => {})
    watched.set(sessionId, () => {
      unsubSource()
      unsubRetention()
      tips?.set(sessionId, undefined)
    })
    syncSession(sessionId)
  }

  const syncList = () => {
    for (const id of sessions.list.getSnapshot().ids ?? []) watch(id)
  }
  const unsubList = sessions.list.subscribe(syncList)
  syncList()

  return () => {
    unsubList()
    for (const dispose of watched.values()) dispose()
    watched.clear()
  }
}
