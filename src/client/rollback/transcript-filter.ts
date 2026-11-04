import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  invalidatePromptHistory,
  promptLedgerFor,
} from '../prompt/ledger-store.ts'
import { promptsFromSessionEntries } from './prompt-entries.ts'
import {
  activeRollbackContinueAfterSeq,
  activeRollbackUndoTip,
  keepPrefixLoadThroughSeq,
  needsKeepPrefixHistory,
  presentRollbackTranscript,
} from './transcript.ts'
import type { RollbackUndoTipStore } from './undo-tip.ts'

interface EventSource {
  getSnapshot(): { entries: readonly SessionEventLikeEntry[], hasMore: boolean, revision: number }
  subscribe(listener: () => void): () => void
  replace?(entries: readonly SessionEventLikeEntry[], hasMore?: boolean): void
}

interface SessionHandle {
  loadThrough?(seq: number): Promise<void>
  loadOlder?(): Promise<void>
  readonly hasMore?: boolean
  readonly loadingOlder?: boolean
  readonly baseSeq?: number
  readonly openState?: string
  /** Session snapshot invalidation (open/hasMore/loadingOlder). */
  subscribe?(listener: () => void): () => void
}

interface SessionBinding {
  readonly eventSource: EventSource
  readonly session?: SessionHandle
}

interface SessionsService {
  list: { getSnapshot(): { ids: readonly SessionId[] }, subscribe(listener: () => void): () => void }
  binding(id: SessionId): SessionBinding | undefined
  retainInfo(id: SessionId): { subscribe(listener: () => void): () => void }
}

/** Cap page fetches so a missing keep-prefix cannot spin Desktop on "loading history". */
const KEEP_PREFIX_MAX_PAGES = 12

/**
 * Keep Chat's loaded window aligned with rollback surface semantics without
 * rewriting the Host append-only log. Also refreshes the session undo tip used
 * by the composer + / command menu.
 *
 * After a restore tip lands, Chat often only has the recent page (rolled-back
 * turns + marker). Filtering removes those turns and leaves the notice alone —
 * so we page older history through the keep-prefix cut until earlier messages
 * reappear (at most once per tip, bounded page count).
 */
export function installRollbackTranscriptFilter(
  ctx: Context,
  tips?: RollbackUndoTipStore,
): () => void {
  const sessions = ctx.get('sessions') as SessionsService | undefined
  if (sessions?.list === undefined || typeof sessions.binding !== 'function') return () => {}

  const watched = new Map<SessionId, () => void>()
  /** Tip seqs that finished a keep-prefix load attempt (success or definitive give-up). */
  const keepPrefixAttempted = new Map<SessionId, number>()
  const loadingKeepPrefix = new Set<SessionId>()

  /** loadThrough/loadOlder no-op unless the Session finished opening. */
  const sessionOpen = (session: SessionHandle): boolean => (
    session.openState === undefined || session.openState === 'open'
  )

  const requestKeepPrefix = (sessionId: SessionId, binding: SessionBinding, entries: readonly SessionEventLikeEntry[]) => {
    if (loadingKeepPrefix.has(sessionId)) return
    const tipSeq = activeRollbackContinueAfterSeq(entries)
    if (tipSeq === undefined) return
    if (keepPrefixAttempted.get(sessionId) === tipSeq) return
    const session = binding.session
    const source = binding.eventSource
    if (session === undefined || source.replace === undefined) return
    // Still opening / already paging — retry on the next session or event subscribe.
    // Never latch attempted here: loadThrough is a no-op until openState === 'open'.
    if (!sessionOpen(session) || session.loadingOlder === true) return

    const target = keepPrefixLoadThroughSeq(entries)
    // Prefer Session.hasMore — eventSource.hasMore can lag after a surgical replace.
    if (session.hasMore === false) {
      keepPrefixAttempted.set(sessionId, tipSeq)
      return
    }
    if (target === undefined) {
      keepPrefixAttempted.set(sessionId, tipSeq)
      return
    }
    if (typeof session.baseSeq === 'number' && session.baseSeq <= target
      && !needsKeepPrefixHistory(entries, true)) {
      // Window already covers the cut and keep-prefix is visible — done.
      keepPrefixAttempted.set(sessionId, tipSeq)
      return
    }
    if (typeof session.loadThrough !== 'function' && typeof session.loadOlder !== 'function') {
      keepPrefixAttempted.set(sessionId, tipSeq)
      return
    }

    loadingKeepPrefix.add(sessionId)
    void (async () => {
      try {
        if (typeof session.loadThrough === 'function') {
          await session.loadThrough(target)
        }
        // loadThrough can no-op when baseSeq already covers the cut while the
        // filtered window is still tip-only — page older as a fallback.
        if (typeof session.loadOlder === 'function') {
          for (let page = 0; page < KEEP_PREFIX_MAX_PAGES; page += 1) {
            const snap = source.getSnapshot()
            const presented = presentRollbackTranscript(snap.entries)
            if (!needsKeepPrefixHistory(presented, snap.hasMore || session.hasMore !== false)) break
            if (session.hasMore === false || session.loadingOlder === true) break
            await session.loadOlder()
          }
        }
      } finally {
        keepPrefixAttempted.set(sessionId, tipSeq)
        loadingKeepPrefix.delete(sessionId)
        // One re-sync after paging so the filter applies to the expanded window.
        syncSession(sessionId)
      }
    })()
  }

  const syncSession = (sessionId: SessionId) => {
    const binding = sessions.binding(sessionId)
    const source = binding?.eventSource
    if (source?.replace === undefined) {
      tips?.set(sessionId, undefined)
      return
    }
    const window = source.getSnapshot()
    // Snapshot prompts before filtering so ↑↓ history stays an input log, not a
    // rollback view of the chat surface.
    const before = promptLedgerFor(sessionId).list().length
    promptLedgerFor(sessionId).observe(promptsFromSessionEntries(window.entries))
    if (promptLedgerFor(sessionId).list().length !== before) {
      invalidatePromptHistory(sessionId)
    }
    const presented = presentRollbackTranscript(window.entries)
    tips?.set(sessionId, activeRollbackUndoTip(presented)?.turn)
    const tipSeq = activeRollbackContinueAfterSeq(presented)
    if (tipSeq === undefined) keepPrefixAttempted.delete(sessionId)
    // Filter first, then optionally page older history.
    if (presented !== window.entries) source.replace(presented, window.hasMore)
    if (needsKeepPrefixHistory(presented, window.hasMore) && binding !== undefined) {
      requestKeepPrefix(sessionId, binding, presented)
    }
  }

  const watch = (sessionId: SessionId) => {
    if (watched.has(sessionId)) return
    const binding = sessions.binding(sessionId)
    if (binding === undefined) return
    const source = binding.eventSource
    const retention = sessions.retainInfo?.(sessionId)
    const unsubSource = source.subscribe(() => { syncSession(sessionId) })
    // open()/hasMore flips notify the Session snapshot, not eventSource — without this
    // we can filter the tail page during openState=loading and never retry keep-prefix.
    const unsubSession = binding.session?.subscribe?.(() => { syncSession(sessionId) }) ?? (() => {})
    const unsubRetention = retention?.subscribe(() => {
      if (sessions.binding(sessionId) === undefined) {
        watched.get(sessionId)?.()
        watched.delete(sessionId)
        loadingKeepPrefix.delete(sessionId)
        keepPrefixAttempted.delete(sessionId)
        tips?.set(sessionId, undefined)
      }
    }) ?? (() => {})
    watched.set(sessionId, () => {
      unsubSource()
      unsubSession()
      unsubRetention()
      loadingKeepPrefix.delete(sessionId)
      keepPrefixAttempted.delete(sessionId)
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
    loadingKeepPrefix.clear()
    keepPrefixAttempted.clear()
  }
}
