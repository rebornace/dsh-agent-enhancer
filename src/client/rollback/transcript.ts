import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { isUndoId } from '../../identity.ts'
import { isRollbackMarkerMessage, turnFromRollbackMarkerId } from './marker.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function surfaceOpOf(event: SessionEvent): 'append' | { op: 'replace', startSeq: number, endSeq: number } | undefined {
  const op = (event as { surfaceOp?: unknown }).surfaceOp
  if (op === 'append') return 'append'
  if (!isRecord(op) || op.op !== 'replace') return undefined
  if (typeof op.startSeq !== 'number' || typeof op.endSeq !== 'number') return undefined
  return { op: 'replace', startSeq: op.startSeq, endSeq: op.endSeq }
}

function isRollbackMarkerEvent(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  return isRollbackMarkerMessage(event.data.source, event.data.id)
}

function isUndoCopyEvent(event: SessionEvent): boolean {
  switch (event.type) {
    case 'user/message':
      return isUndoId(event.data.id)
    case 'system/message':
    case 'developer/message':
    case 'assistant/message':
    case 'tool/result':
      return isUndoId(event.data.message.id)
    default:
      return false
  }
}

function markerStillActive(marker: SessionEvent, events: readonly SessionEvent[]): boolean {
  return !events.some(event => {
    if (event.seq <= marker.seq) return false
    const op = surfaceOpOf(event)
    return op !== undefined && op !== 'append' && op.startSeq <= marker.seq && op.endSeq >= marker.seq
  })
}

function asAppend(event: SessionEvent): SessionEvent {
  return { ...event, surfaceOp: 'append' } as SessionEvent
}

function turnOfEvent(event: SessionEvent): number | undefined {
  if (event.type === 'turn/start' || event.type === 'turn/end'
    || event.type === 'step/start' || event.type === 'step/end') {
    return event.data.turn
  }
  const data = event.data as { turn?: unknown }
  return typeof data.turn === 'number' ? data.turn : undefined
}

function activeMarkersOf(events: readonly SessionEvent[]): SessionEvent[] {
  return events.filter(event => isRollbackMarkerEvent(event) && markerStillActive(event, events))
}

/**
 * Lowest turn number covered by an active rollback marker, if any.
 * TurnNavigator's host `turnOutline` still lists every turn; Client filters from this cut.
 */
export function activeRollbackHideTurnsFrom(
  entries: readonly SessionEventLikeEntry[],
): number | undefined {
  const events = entries.flatMap(entry => entry.type === 'event' ? [entry.event] : [])
  let hideTurnsFrom: number | undefined
  for (const event of activeMarkersOf(events)) {
    const turn = event.type === 'user/message' ? turnFromRollbackMarkerId(event.data.id) : undefined
    if (turn !== undefined) {
      hideTurnsFrom = hideTurnsFrom === undefined ? turn : Math.min(hideTurnsFrom, turn)
    }
  }
  return hideTurnsFrom
}

/** Latest active restore marker seq; events after it are a fresh continuation, not rolled-back history. */
export function activeRollbackContinueAfterSeq(
  entries: readonly SessionEventLikeEntry[],
): number | undefined {
  const markers = activeMarkersOf(entries.flatMap(entry => entry.type === 'event' ? [entry.event] : []))
  if (markers.length === 0) return undefined
  return Math.max(...markers.map(event => Number(event.seq)))
}

/**
 * Turn number for the latest undoable restore tip, if Host would still accept undo.
 * After rollback, turn chrome is gone so Chat may place the marker outside a TurnLocation;
 * callers should prefer this tip over message-row heuristics.
 */
export function activeRollbackUndoTip(
  entries: readonly SessionEventLikeEntry[],
): { readonly turn: number } | undefined {
  const events = entries.flatMap(entry => entry.type === 'event' ? [entry.event] : [])
  let tip: { turn: number, seq: number } | undefined
  for (const event of events) {
    if (!isRollbackMarkerEvent(event) || !markerStillActive(event, events)) continue
    if (event.type !== 'user/message') continue
    const turn = turnFromRollbackMarkerId(event.data.id)
    if (turn === undefined) continue
    if (tip === undefined || Number(event.seq) >= tip.seq) tip = { turn, seq: Number(event.seq) }
  }
  if (tip === undefined) return undefined
  const later = events.some(event => Number(event.seq) > tip.seq
    && !isRollbackMarkerEvent(event) && !isUndoCopyEvent(event))
  return later ? undefined : { turn: tip.turn }
}

export function filterTurnOutline(
  outline: unknown,
  hideTurnsFrom: number | undefined,
  continueAfterSeq?: number,
): unknown {
  if (hideTurnsFrom === undefined || !Array.isArray(outline)) return outline
  const next = outline.filter(entry => {
    if (!isRecord(entry) || typeof entry.turn !== 'number') return true
    if (entry.turn < hideTurnsFrom) return true
    // New turns started after the restore tip must stay on the rail.
    return continueAfterSeq !== undefined
      && typeof entry.seq === 'number'
      && entry.seq > continueAfterSeq
  })
  return next.length === outline.length ? outline : next
}

/**
 * Chat indexes turn chrome by turn number. When an undo shell and a later real
 * prompt share a turn id (Agent maintenance freezes lastTurn), remap shells to
 * chronological display turns so the restored reply is not collapsed.
 */
function renumberCollidingTurns(
  entries: readonly SessionEventLikeEntry[],
): readonly SessionEventLikeEntry[] {
  const starts: { seq: number, turn: number }[] = []
  const seen = new Map<number, number>()
  let collided = false
  for (const entry of entries) {
    if (entry.type !== 'event' || entry.event.type !== 'turn/start') continue
    const turn = entry.event.data.turn
    const seq = Number(entry.event.seq)
    if (seen.has(turn)) collided = true
    seen.set(turn, (seen.get(turn) ?? 0) + 1)
    starts.push({ seq, turn })
  }
  if (!collided || starts.length === 0) return entries

  const shells = starts.map((start, index) => ({
    startSeq: start.seq,
    endSeq: index + 1 < starts.length ? starts[index + 1]!.seq - 1 : Number.POSITIVE_INFINITY,
    from: start.turn,
    to: index + 1,
  }))

  let changed = false
  const next = entries.map(entry => {
    if (entry.type !== 'event') return entry
    const event = entry.event
    const seq = Number(event.seq)
    const shell = shells.find(item => seq >= item.startSeq && seq <= item.endSeq)
    if (shell === undefined || shell.from === shell.to) return entry
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      changed = true
      return {
        type: 'event',
        event: { ...event, data: { ...event.data, turn: shell.to } },
      } as SessionEventLikeEntry
    }
    if (event.type === 'step/start' || event.type === 'step/end') {
      changed = true
      return {
        type: 'event',
        event: { ...event, data: { ...event.data, turn: shell.to } },
      } as SessionEventLikeEntry
    }
    const data = event.data as { turn?: unknown }
    if (typeof data.turn === 'number' && data.turn === shell.from) {
      changed = true
      return {
        type: 'event',
        event: { ...event, data: { ...event.data, turn: shell.to } },
      } as SessionEventLikeEntry
    }
    return entry
  })
  return changed ? next : entries
}

/**
 * Present rollback to the human transcript: hide shadowed append-origin messages,
 * drop rolled-back turn boundaries (so Completed/duration and the turn rail clear),
 * show active rollback markers as append tips, and keep undo copies visible.
 *
 * Host surface replace only updates model-visible history; Chat matches append-origin
 * events only, so the Client must reshape the loaded window for UI.
 */
export function presentRollbackTranscript(
  entries: readonly SessionEventLikeEntry[],
): readonly SessionEventLikeEntry[] {
  const events = entries.flatMap(entry => entry.type === 'event' ? [entry.event] : [])
  const everShadowed = new Set<number>()
  const activeMarkers = new Set<number>()
  const hideTurnsFrom = activeRollbackHideTurnsFrom(entries)
  const continueAfterSeq = activeRollbackContinueAfterSeq(entries)
  const undoneTurnCuts = new Map<number, number>()
  for (const event of events) {
    if (!isRollbackMarkerEvent(event)) continue
    for (const seq of event.sourceEventSeqs ?? []) everShadowed.add(Number(seq))
    if (markerStillActive(event, events)) {
      activeMarkers.add(Number(event.seq))
      continue
    }
    // Marker replaced by an undo copy: suppress the empty pre-undo turn shell only
    // before that marker (the fresh turn/start after the marker must stay).
    const replaced = events.some(candidate => {
      if (candidate.seq <= event.seq || !isUndoCopyEvent(candidate)) return false
      const op = surfaceOpOf(candidate)
      return op !== undefined && op !== 'append'
        && op.startSeq <= Number(event.seq) && op.endSeq >= Number(event.seq)
    })
    if (!replaced || event.type !== 'user/message') continue
    const turn = turnFromRollbackMarkerId(event.data.id)
    if (turn === undefined) continue
    const prior = undoneTurnCuts.get(turn)
    undoneTurnCuts.set(turn, prior === undefined ? Number(event.seq) : Math.min(prior, Number(event.seq)))
  }
  if (everShadowed.size === 0 && activeMarkers.size === 0
    && !events.some(isUndoCopyEvent)) return renumberCollidingTurns(entries)

  let changed = false
  const next: SessionEventLikeEntry[] = []
  for (const entry of entries) {
    if (entry.type !== 'event') {
      next.push(entry)
      continue
    }
    const event = entry.event
    if (everShadowed.has(Number(event.seq))) {
      changed = true
      continue
    }
    const ownedTurn = turnOfEvent(event)
    // After undo, a fresh turn/step shell wraps the restored copies. Hide the
    // original empty shell that still sits before the undone marker.
    const undoneCut = ownedTurn === undefined ? undefined : undoneTurnCuts.get(ownedTurn)
    if (undoneCut !== undefined
      && (event.type === 'turn/start' || event.type === 'turn/end'
        || event.type === 'step/start' || event.type === 'step/end')
      && Number(event.seq) < undoneCut) {
      changed = true
      continue
    }
    // Drop rolled-back turn chrome / leftovers before the restore tip only.
    // Continuation turns after the tip often reuse turn numbers >= hideTurnsFrom;
    // hiding those would blank the new model reply.
    const beforeTip = continueAfterSeq === undefined || Number(event.seq) <= continueAfterSeq
    if (hideTurnsFrom !== undefined && ownedTurn !== undefined && ownedTurn >= hideTurnsFrom
      && beforeTip && !isRollbackMarkerEvent(event) && !isUndoCopyEvent(event)) {
      changed = true
      continue
    }
    if (isRollbackMarkerEvent(event)) {
      if (!activeMarkers.has(Number(event.seq))) {
        changed = true
        continue
      }
      if (surfaceOpOf(event) === 'append') {
        next.push(entry)
        continue
      }
      next.push({ type: 'event', event: asAppend(event) })
      changed = true
      continue
    }
    if (isUndoCopyEvent(event) && surfaceOpOf(event) !== 'append') {
      next.push({ type: 'event', event: asAppend(event) })
      changed = true
      continue
    }
    next.push(entry)
  }
  return renumberCollidingTurns(changed ? next : entries)
}
