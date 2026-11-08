import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { visiblePendingKind } from './pending-kind.ts'
import type { RunAlertEvent, SessionStatusFace, SessionStatusMap } from './types.ts'

function statusOf(map: SessionStatusMap | undefined, sessionId: SessionId): SessionStatusFace | undefined {
  return map?.get(sessionId)
}

function pendingKey(face: SessionStatusFace | undefined): string | undefined {
  const kind = visiblePendingKind(face?.pendingInteraction?.kind)
  if (kind === undefined) return undefined
  const key = face?.pendingInteraction?.key
  return typeof key === 'string' && key !== '' ? `${kind}:${key}` : kind
}

/**
 * Diff two status snapshots into alert edges.
 * `away` (hidden or unfocused) enables a running→false finish edge when the
 * user left the window — official `completionUnread` only fires off mainView.
 */
export function detectStatusEdges(
  previous: SessionStatusMap | undefined,
  next: SessionStatusMap,
  options: { readonly away: boolean } = { away: false },
): readonly RunAlertEvent[] {
  const events: RunAlertEvent[] = []
  const seenFinish = new Set<SessionId>()

  for (const [sessionId, face] of next) {
    const before = statusOf(previous, sessionId)

    const unreadRose = before?.completionUnread !== true && face.completionUnread === true
    const runningDropped = before?.running === true && face.running === false
    if (unreadRose || (options.away && runningDropped)) {
      if (!seenFinish.has(sessionId)) {
        seenFinish.add(sessionId)
        events.push({ sessionId, kind: 'finished' })
      }
    }

    const nextPending = pendingKey(face)
    const prevPending = pendingKey(before)
    if (nextPending !== undefined && nextPending !== prevPending) {
      const pendingKind = visiblePendingKind(face.pendingInteraction?.kind)
      events.push({
        sessionId,
        kind: 'pending',
        ...(pendingKind === undefined ? {} : { pendingKind }),
      })
    }
  }

  return events
}

export function detectSessionError(
  sessionId: SessionId,
  message: string,
): RunAlertEvent {
  const trimmed = message.replace(/\s+/gu, ' ').trim()
  return {
    sessionId,
    kind: 'error',
    message: trimmed === '' ? '—' : trimmed.slice(0, 160),
  }
}
