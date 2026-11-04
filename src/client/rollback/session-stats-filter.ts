import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { activityStatsFromEntries } from './transcript.ts'

interface EventSource {
  getSnapshot(): { entries: readonly SessionEventLikeEntry[], hasMore: boolean, revision: number }
  subscribe(listener: () => void): () => void
}

interface ProjectionStore {
  get(key: string): unknown
  seqOf(key: string): number | undefined
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Fold surface turns/steps onto the Host sessionStats object. Never invent a
 * zeroed timing shell — ActivityPill falls back to a non-button PlainPill when
 * llmMs/toolMs/ttft/speed are all empty, which makes 轮/步 look unclickable.
 */
export function withActivityCounts(
  base: unknown,
  activity: { readonly turns: number, readonly steps: number },
): unknown {
  if (!isRecord(base)) return base
  if (base.turns === activity.turns && base.steps === activity.steps) return base
  return { ...base, turns: activity.turns, steps: activity.steps }
}

/**
 * Composer ActivityPill reads Host `sessionStats` (whole append-only log).
 * Always own turns+steps from the presented chat surface so the gauge matches
 * visible conversation on first paint — Host whole-log (and undo shells) must
 * never inflate 轮/步. Timing / tok/s stay on the Host projection.
 */
export function installRollbackSessionStatsFilter(ctx: Context): () => void {
  const sessions = ctx.get('sessions') as SessionsService | undefined
  if (sessions?.list === undefined || typeof sessions.binding !== 'function') return () => {}

  const watched = new Map<SessionId, () => void>()
  /** Last Host-authored (or Host-merged) stats, never our published echo alone. */
  const hostStats = new Map<SessionId, unknown>()
  /** Last value we applied — ignore face echoes of our own writes. */
  const published = new Map<SessionId, unknown>()

  const publish = (sessionId: SessionId) => {
    const binding = sessions.binding(sessionId)
    const projections = binding?.session.projections
    const source = binding?.eventSource
    if (projections?.get === undefined || projections.apply === undefined || source === undefined) return

    const base = hostStats.get(sessionId)
    // Wait for Host sessionStats so we never publish llmMs:0 and strip the dialog pill.
    if (!isRecord(base)) return

    const entries = source.getSnapshot().entries
    const next = withActivityCounts(base, activityStatsFromEntries(entries))
    if (Object.is(next, projections.get('sessionStats'))) return
    const currentSeq = Number(projections.seqOf('sessionStats') ?? 0)
    projections.apply('sessionStats', next, Number.isFinite(currentSeq) ? currentSeq + 1 : 1)
    published.set(sessionId, next)
  }

  const watch = (sessionId: SessionId) => {
    if (watched.has(sessionId)) return
    const binding = sessions.binding(sessionId)
    if (binding === undefined) return
    const projections = binding.session.projections
    if (projections?.faceOf === undefined || projections.get === undefined) return

    let applying = false
    const onStats = () => {
      if (applying) return
      const current = projections.get('sessionStats')
      // Echo of our own apply — keep the prior Host timing snapshot.
      if (current === published.get(sessionId)) return
      hostStats.set(sessionId, current)
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
    const unsubStats = projections.faceOf('sessionStats').subscribe(onStats)
    const retention = sessions.retainInfo?.(sessionId)
    const unsubRetention = retention?.subscribe(() => {
      if (sessions.binding(sessionId) === undefined) {
        watched.get(sessionId)?.()
        watched.delete(sessionId)
        hostStats.delete(sessionId)
        published.delete(sessionId)
      }
    }) ?? (() => {})
    watched.set(sessionId, () => {
      unsubSource()
      unsubStats()
      unsubRetention()
      hostStats.delete(sessionId)
      published.delete(sessionId)
    })
    const initial = projections.get('sessionStats')
    if (isRecord(initial)) hostStats.set(sessionId, initial)
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
    hostStats.clear()
    published.clear()
  }
}
