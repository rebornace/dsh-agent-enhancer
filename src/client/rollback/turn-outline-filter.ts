import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  activeRollbackContinueAfterSeq,
  activeRollbackHideTurnsFrom,
  filterTurnOutline,
  undoShellRangesFromEntries,
} from './transcript.ts'

interface EventSource {
  getSnapshot(): { entries: readonly SessionEventLikeEntry[], hasMore: boolean, revision: number }
  subscribe(listener: () => void): () => void
}

interface ProjectionStore {
  get(key: string): unknown
  seqOf(key: string): number | undefined
  // Seq is a branded number on the host/client store; avoid importing SessionSeq
  // (not a Desktop client seed module — value imports crash web boot).
  apply(key: string, value: unknown, seq: number): void
  faceOf(key: string): { subscribe(listener: () => void): () => void }
}

interface SessionBinding {
  readonly eventSource: EventSource
  readonly session: { readonly projections: ProjectionStore }
}

interface SessionsService {
  list: { getSnapshot(): { ids: readonly SessionId[] }, subscribe(listener: () => void): () => void }
  binding(id: SessionId): SessionBinding | undefined
  retainInfo(id: SessionId): { subscribe(listener: () => void): () => void }
}

/**
 * TurnNavigator merges loaded chat items with the host `turnOutline` projection.
 * Surface replace and transcript filtering clear loaded marks, but outline still
 * lists every historical turn as unloaded — re-apply a filtered outline so the
 * rail drops rolled-back turns.
 */
export function installRollbackTurnOutlineFilter(ctx: Context): () => void {
  const sessions = ctx.get('sessions') as SessionsService | undefined
  if (sessions?.list === undefined || typeof sessions.binding !== 'function') return () => {}

  const watched = new Map<SessionId, () => void>()
  const hostOutlines = new Map<SessionId, unknown>()

  const publish = (sessionId: SessionId) => {
    const binding = sessions.binding(sessionId)
    const projections = binding?.session.projections
    const source = binding?.eventSource
    if (projections?.get === undefined || projections.apply === undefined || source === undefined) return

    const entries = source.getSnapshot().entries
    const hideTurnsFrom = activeRollbackHideTurnsFrom(entries)
    const continueAfterSeq = activeRollbackContinueAfterSeq(entries)
    const omitShellRanges = undoShellRangesFromEntries(entries)
    const base = hostOutlines.has(sessionId) ? hostOutlines.get(sessionId) : projections.get('turnOutline')
    // Omit Host undo scaffolding turns so the rail does not gain a fake "new round".
    const filtered = filterTurnOutline(base, hideTurnsFrom, continueAfterSeq, omitShellRanges)
    if (Object.is(filtered, projections.get('turnOutline'))) return
    const currentSeq = Number(projections.seqOf('turnOutline') ?? 0)
    const nextSeq = Number.isFinite(currentSeq) ? currentSeq + 1 : 1
    projections.apply('turnOutline', filtered, nextSeq)
  }

  const watch = (sessionId: SessionId) => {
    if (watched.has(sessionId)) return
    const binding = sessions.binding(sessionId)
    if (binding === undefined) return
    const projections = binding.session.projections
    if (projections?.faceOf === undefined || projections.get === undefined) return

    let applying = false
    const onOutline = () => {
      if (applying) return
      hostOutlines.set(sessionId, projections.get('turnOutline'))
      applying = true
      try {
        publish(sessionId)
      } finally {
        applying = false
      }
    }
    const onEvents = () => {
      applying = true
      try {
        publish(sessionId)
      } finally {
        applying = false
      }
    }
    const unsubSource = binding.eventSource.subscribe(onEvents)
    const unsubOutline = projections.faceOf('turnOutline').subscribe(onOutline)
    const retention = sessions.retainInfo?.(sessionId)
    const unsubRetention = retention?.subscribe(() => {
      if (sessions.binding(sessionId) === undefined) {
        watched.get(sessionId)?.()
        watched.delete(sessionId)
        hostOutlines.delete(sessionId)
      }
    }) ?? (() => {})
    watched.set(sessionId, () => {
      unsubSource()
      unsubOutline()
      unsubRetention()
      hostOutlines.delete(sessionId)
    })
    hostOutlines.set(sessionId, projections.get('turnOutline'))
    onEvents()
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
    hostOutlines.clear()
  }
}
