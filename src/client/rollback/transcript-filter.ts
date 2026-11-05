import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  invalidatePromptHistory,
  promptLedgerFor,
} from '../prompt/ledger-store.ts'
import type { SessionCutCache } from './cut-cache.ts'
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

interface RawWindow {
  /** Unfiltered entries unioned from upstream (before cut projection). */
  entries: readonly SessionEventLikeEntry[]
  hasMore: boolean
}

/** Cap page fetches so a missing keep-prefix cannot spin Desktop on "loading history". */
const KEEP_PREFIX_MAX_PAGES = 12

function eventSeq(entry: SessionEventLikeEntry): number | undefined {
  if (entry.type !== 'event') return undefined
  const value = Number(entry.event.seq)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Union raw + incoming by seq so cut `replace` can hide turns without destroying
 * the local copy needed to reveal them again on undo.
 *
 * Non-event rows (gaps / chrome) are taken only from `incoming`. Concatenating
 * both sides would duplicate them on every sync → `replace` → subscribe loop and
 * freeze the UI while the model streams after a cut restore.
 */
export function mergeTranscriptEntries(
  raw: readonly SessionEventLikeEntry[],
  incoming: readonly SessionEventLikeEntry[],
): readonly SessionEventLikeEntry[] {
  const bySeq = new Map<number, SessionEventLikeEntry>()
  for (const entry of raw) {
    const seq = eventSeq(entry)
    if (seq !== undefined) bySeq.set(seq, entry)
  }
  const rest: SessionEventLikeEntry[] = []
  for (const entry of incoming) {
    const seq = eventSeq(entry)
    if (seq === undefined) {
      rest.push(entry)
      continue
    }
    bySeq.set(seq, entry)
  }
  return [
    ...[...bySeq.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, entry]) => entry),
    ...rest,
  ]
}

function sameEntries(
  left: readonly SessionEventLikeEntry[],
  right: readonly SessionEventLikeEntry[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    if (a === b) continue
    if (a.type !== b.type) return false
    if (a.type === 'event' && b.type === 'event' && Number(a.event.seq) !== Number(b.event.seq)) {
      return false
    }
  }
  return true
}

/**
 * Keep Chat's loaded window aligned with rollback cut / tip semantics without
 * rewriting the Host append-only log. Also refreshes the session undo tip used
 * by the composer + / command menu.
 *
 * Critical: cut projection uses `eventSource.replace`, which would otherwise
 * permanently drop withdrawn turns from the client window. We keep a raw union
 * so clearing the cut can put those turns back without a tip append.
 */
export function installRollbackTranscriptFilter(
  ctx: Context,
  tips?: RollbackUndoTipStore,
  cuts?: SessionCutCache,
): () => void {
  const sessions = ctx.get('sessions') as SessionsService | undefined
  if (sessions?.list === undefined || typeof sessions.binding !== 'function') return () => {}

  const watched = new Map<SessionId, () => void>()
  const rawWindows = new Map<SessionId, RawWindow>()
  /** Tip/cut seqs that finished a keep-prefix load attempt (success or definitive give-up). */
  const keepPrefixAttempted = new Map<SessionId, number>()
  const loadingKeepPrefix = new Set<SessionId>()
  /** Prevent replace→subscribe→sync re-entry from stacking during stream updates. */
  const syncing = new Set<SessionId>()

  /** loadThrough/loadOlder no-op unless the Session finished opening. */
  const sessionOpen = (session: SessionHandle): boolean => (
    session.openState === undefined || session.openState === 'open'
  )

  const requestKeepPrefix = (sessionId: SessionId, binding: SessionBinding, entries: readonly SessionEventLikeEntry[]) => {
    if (loadingKeepPrefix.has(sessionId)) return
    const cut = cuts?.get(sessionId) ?? null
    const tipSeq = activeRollbackContinueAfterSeq(entries, cut)
    if (tipSeq === undefined) return
    if (keepPrefixAttempted.get(sessionId) === tipSeq) return
    const session = binding.session
    const source = binding.eventSource
    if (session === undefined || source.replace === undefined) return
    // Still opening / already paging — retry on the next session or event subscribe.
    // Never latch attempted here: loadThrough is a no-op until openState === 'open'.
    if (!sessionOpen(session) || session.loadingOlder === true) return

    const target = keepPrefixLoadThroughSeq(entries, cut)
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
      && !needsKeepPrefixHistory(entries, true, cut)) {
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
            const liveCut = cuts?.get(sessionId) ?? null
            const raw = rawWindows.get(sessionId)?.entries ?? snap.entries
            const presented = presentRollbackTranscript(raw, liveCut)
            if (!needsKeepPrefixHistory(presented, snap.hasMore || session.hasMore !== false, liveCut)) break
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
    if (syncing.has(sessionId)) return
    syncing.add(sessionId)
    try {
      const binding = sessions.binding(sessionId)
      const source = binding?.eventSource
      if (source?.replace === undefined) {
        tips?.set(sessionId, undefined)
        return
      }
      const window = source.getSnapshot()
      const cut = cuts?.get(sessionId) ?? null
      const previous = rawWindows.get(sessionId)
      // Union by seq: filtered `replace` echoes cannot shrink raw, so undo can
      // re-project withdrawn turns without tip appends. loadThrough/append only add.
      const merged = previous === undefined
        ? window.entries
        : mergeTranscriptEntries(previous.entries, window.entries)
      const raw: RawWindow = { entries: merged, hasMore: window.hasMore }
      rawWindows.set(sessionId, raw)

      // Snapshot prompts from the unfiltered raw so ↑↓ history stays an input log.
      const before = promptLedgerFor(sessionId).list().length
      promptLedgerFor(sessionId).observe(promptsFromSessionEntries(raw.entries))
      if (promptLedgerFor(sessionId).list().length !== before) {
        invalidatePromptHistory(sessionId)
      }
      const presented = presentRollbackTranscript(raw.entries, cut)
      tips?.set(sessionId, activeRollbackUndoTip(presented, cut)?.turn)
      const tipSeq = activeRollbackContinueAfterSeq(presented, cut)
      if (tipSeq === undefined) keepPrefixAttempted.delete(sessionId)
      // Filter first, then optionally page older history.
      if (!sameEntries(presented, window.entries)) {
        source.replace(presented, raw.hasMore)
      }
      if (needsKeepPrefixHistory(presented, window.hasMore, cut) && binding !== undefined) {
        requestKeepPrefix(sessionId, binding, presented)
      }
    } finally {
      syncing.delete(sessionId)
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
        rawWindows.delete(sessionId)
        tips?.set(sessionId, undefined)
        cuts?.clear(sessionId)
      }
    }) ?? (() => {})
    watched.set(sessionId, () => {
      unsubSource()
      unsubSession()
      unsubRetention()
      loadingKeepPrefix.delete(sessionId)
      keepPrefixAttempted.delete(sessionId)
      rawWindows.delete(sessionId)
      tips?.set(sessionId, undefined)
    })
    syncSession(sessionId)
  }

  const syncList = () => {
    for (const id of sessions.list.getSnapshot().ids ?? []) watch(id)
  }
  const unsubList = sessions.list.subscribe(syncList)
  const unsubCuts = cuts?.subscribe(() => {
    for (const id of watched.keys()) syncSession(id)
  }) ?? (() => {})
  syncList()

  return () => {
    unsubList()
    unsubCuts()
    for (const dispose of watched.values()) dispose()
    watched.clear()
    loadingKeepPrefix.clear()
    keepPrefixAttempted.clear()
    rawWindows.clear()
  }
}
