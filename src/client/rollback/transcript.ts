import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  inUndoShellRange,
  isUndoCopyEvent as isHostUndoCopyEvent,
  undoShellRanges,
} from '../../host/checkpoint/activity.ts'
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
  return isHostUndoCopyEvent(event)
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

/**
 * Keep the live tip in the event window for keep-prefix / undo-tip bookkeeping, but
 * never as a Chat-visible turn. Ordinary `context` rows are hidden by Desktop; a
 * prior rewrite to `source.kind: 'user'` must be undone.
 */
function asBookkeepingTip(event: SessionEvent): SessionEvent {
  if (event.type !== 'user/message') return asAppend(event)
  const source = event.data.source as { kind?: unknown, form?: unknown, summary?: unknown }
  const alreadyHidden = surfaceOpOf(event) === 'append' && source.kind === 'checkpoint-rollback'
  if (alreadyHidden) return event
  return {
    ...event,
    surfaceOp: 'append',
    data: {
      ...event.data,
      source: {
        kind: 'checkpoint-rollback',
        form: 'notice',
        ...(typeof source.summary === 'string' ? { summary: source.summary } : {}),
      },
    },
  } as SessionEvent
}

function turnOfEvent(event: SessionEvent): number | undefined {
  if (event.type === 'turn/start' || event.type === 'turn/end'
    || event.type === 'step/start' || event.type === 'step/end') {
    return event.data.turn
  }
  const data = event.data as { turn?: unknown }
  return typeof data.turn === 'number' ? data.turn : undefined
}

/**
 * Still-active restore markers that have not been unmasked by later undo copies.
 * Append-only undo leaves the tip uncovered in the log but re-attaches sources
 * after the latest marker — treat that as unmask.
 */
function activeTipMarkers(events: readonly SessionEvent[]): SessionEvent[] {
  const markers: SessionEvent[] = []
  for (const event of events) {
    if (!isRollbackMarkerEvent(event) || !markerStillActive(event, events)) continue
    markers.push(event)
  }
  if (markers.length === 0) return markers
  const latestSeq = Math.max(...markers.map(event => Number(event.seq)))
  if (events.some(event => Number(event.seq) > latestSeq && isUndoCopyEvent(event))) {
    return []
  }
  return markers
}

/** Latest active tip (older uncleared markers are dropped from the Chat window). */
function liveTipMarker(events: readonly SessionEvent[]): SessionEvent | undefined {
  const markers = activeTipMarkers(events)
  if (markers.length === 0) return undefined
  return markers.reduce((latest, event) => (
    Number(event.seq) >= Number(latest.seq) ? event : latest
  ))
}

/**
 * First turn hidden by any still-active tip (stacked uncleared markers keep the
 * most aggressive tip). Marker `rollback:N` means cut before turn N → hide from N.
 */
export function activeRollbackHideTurnsFrom(
  entries: readonly SessionEventLikeEntry[],
): number | undefined {
  let hideTurnsFrom: number | undefined
  for (const tip of activeTipMarkers(entries.flatMap(entry => entry.type === 'event' ? [entry.event] : []))) {
    if (tip.type !== 'user/message') continue
    const turn = turnFromRollbackMarkerId(tip.data.id)
    if (turn === undefined) continue
    hideTurnsFrom = hideTurnsFrom === undefined ? turn : Math.min(hideTurnsFrom, turn)
  }
  return hideTurnsFrom
}

/** Latest live tip seq; events after it are a fresh continuation, not rolled-back history. */
export function activeRollbackContinueAfterSeq(
  entries: readonly SessionEventLikeEntry[],
): number | undefined {
  const tip = liveTipMarker(entries.flatMap(entry => entry.type === 'event' ? [entry.event] : []))
  return tip === undefined ? undefined : Number(tip.seq)
}

/**
 * Oldest seq the Chat window must cover so keep-prefix turns (before the tip) can render.
 * Derived from active tips' `sourceEventSeqs` (the first withdrawn surface node).
 */
export function keepPrefixLoadThroughSeq(
  entries: readonly SessionEventLikeEntry[],
): number | undefined {
  const markers = activeTipMarkers(entries.flatMap(entry => entry.type === 'event' ? [entry.event] : []))
  if (markers.length === 0) return undefined
  let minShadowed: number | undefined
  for (const marker of markers) {
    for (const seq of marker.sourceEventSeqs ?? []) {
      const value = Number(seq)
      if (!Number.isFinite(value)) continue
      minShadowed = minShadowed === undefined ? value : Math.min(minShadowed, value)
    }
  }
  // Without shadowed seqs we cannot aim a bounded loadThrough — callers must not
  // fall back to 0 (that pages the entire log and leaves Desktop on "loading history").
  if (minShadowed === undefined) return undefined
  return Math.max(0, minShadowed - 1)
}

function hasKeepPrefixConversation(entries: readonly SessionEventLikeEntry[]): boolean {
  return entries.some(entry => {
    if (entry.type !== 'event') return false
    const event = entry.event
    if (event.type !== 'user/message' && event.type !== 'assistant/message') return false
    return !isRollbackMarkerEvent(event) && !isUndoCopyEvent(event)
  })
}

/**
 * True when an active restore tip is visible but earlier conversation is still outside
 * the loaded Chat window (filter removed rolled-back turns, leaving mostly the notice).
 */
export function needsKeepPrefixHistory(
  entries: readonly SessionEventLikeEntry[],
  hasMore: boolean,
): boolean {
  if (!hasMore) return false
  if (keepPrefixLoadThroughSeq(entries) === undefined) return false
  return !hasKeepPrefixConversation(entries)
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
  const tip = liveTipMarker(events)
  if (tip === undefined || tip.type !== 'user/message') return undefined
  const turn = turnFromRollbackMarkerId(tip.data.id)
  if (turn === undefined) return undefined
  const later = events.some(event => Number(event.seq) > Number(tip.seq)
    && !isRollbackMarkerEvent(event) && !isUndoCopyEvent(event))
  return later ? undefined : { turn }
}

/** Host undo scaffolding ranges — omit matching turnOutline rows by `seq`. */
export function undoShellRangesFromEntries(
  entries: readonly SessionEventLikeEntry[],
): readonly { readonly turn: number, readonly startSeq: number, readonly endSeq: number }[] {
  return undoShellRanges(entries.flatMap(entry => entry.type === 'event' ? [entry.event] : []))
}

/**
 * Undo copy ids embed the source seq (`…:undo:journal:index:sourceSeq`).
 * Prefer that source's turn/step so Chat can reattach to the original turn/step
 * chrome still in the window — stripping coords left assistant-step nodes null.
 */
function undoSourceSeqOf(id: string): number | undefined {
  const match = /:(\d+)(?::(?:dsh-agent-enhancer|dsh-composer-enhancer):rollback:.*)?$/.exec(id)
  if (match === null) return undefined
  const seq = Number(match[1])
  return Number.isFinite(seq) ? seq : undefined
}

function surfaceMessageIdOf(event: SessionEvent): string | null {
  switch (event.type) {
    case 'user/message':
      return event.data.id
    case 'system/message':
    case 'developer/message':
    case 'assistant/message':
    case 'tool/result':
      return event.data.message.id
    default:
      return null
  }
}

/**
 * Force append-origin for Chat, and rematerialize the source turn/step when the
 * Host undo shell overwrote them with a monotonic scaffolding turn.
 */
function asUnmaskedUndoCopy(
  event: SessionEvent,
  bySeq: ReadonlyMap<number, SessionEvent>,
): SessionEvent {
  const append = surfaceOpOf(event) === 'append' ? event : asAppend(event)
  const id = surfaceMessageIdOf(event)
  if (id === null) return append
  const sourceSeq = undoSourceSeqOf(id)
  const original = sourceSeq === undefined ? undefined : bySeq.get(sourceSeq)
  if (original === undefined) return append

  const originalTurn = turnOfEvent(original)
  const originalStep = (original.data as { step?: unknown }).step
  const data = append.data as { turn?: unknown, step?: unknown }
  const needsTurn = typeof originalTurn === 'number' && data.turn !== originalTurn
  const needsStep = typeof originalStep === 'number' && data.step !== originalStep
  if (!needsTurn && !needsStep && append === event) return event
  if (!needsTurn && !needsStep) return append

  return {
    ...append,
    data: {
      ...append.data,
      ...(typeof originalTurn === 'number' ? { turn: originalTurn } : {}),
      ...(typeof originalStep === 'number' ? { step: originalStep } : {}),
    },
  } as SessionEvent
}

/**
 * Own surface fold (not Host whole-log): dedupe closed steps by `(turn, step)`,
 * then turns = distinct turns with ≥1 closed step. Applied to the *presented*
 * transcript so restore hides rolled-back work and undo shells never inflate
 * the gauge — rewind must not look like extra rounds.
 */
export function activityStatsFromEvents(
  events: readonly SessionEvent[],
): { readonly turns: number, readonly steps: number } {
  const closed = new Set<string>()
  const turns = new Set<number>()
  for (const event of events) {
    if (event.type !== 'step/end') continue
    const key = `${event.data.turn}:${event.data.step}`
    if (closed.has(key)) continue
    closed.add(key)
    turns.add(event.data.turn)
  }
  if (closed.size > 0) return { turns: turns.size, steps: closed.size }

  // Fallback when the loaded window has no step chrome (truncated page / fixtures).
  let steps = 0
  for (const event of events) {
    if (event.type === 'turn/start') {
      turns.add(event.data.turn)
      continue
    }
    if (event.type !== 'assistant/message' || isRollbackMarkerEvent(event)) continue
    steps += 1
    const turn = turnOfEvent(event)
    if (turn !== undefined) turns.add(turn)
  }
  return { turns: turns.size, steps }
}

function sourceTurnStepOf(
  event: SessionEvent,
  bySeq: ReadonlyMap<number, SessionEvent>,
): { readonly turn: number, readonly step: number } | undefined {
  const id = surfaceMessageIdOf(event)
  if (id === null) return undefined
  const sourceSeq = undoSourceSeqOf(id)
  const original = sourceSeq === undefined ? undefined : bySeq.get(sourceSeq)
  if (original !== undefined) {
    const turn = turnOfEvent(original)
    const step = (original.data as { step?: unknown }).step
    if (typeof turn === 'number' && typeof step === 'number') return { turn, step }
  }
  // Source row missing from the loaded window (destroyed by tip filter replace) —
  // fall back to coords already on the undo copy (Host shell turn/step).
  const turn = turnOfEvent(event)
  const step = (event.data as { step?: unknown }).step
  if (typeof turn === 'number' && typeof step === 'number') return { turn, step }
  return undefined
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

function collectStepChromeKeys(entries: readonly SessionEventLikeEntry[]): {
  readonly starts: Set<string>
  readonly ends: Set<string>
} {
  const starts = new Set<string>()
  const ends = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    const event = entry.event
    if (event.type === 'step/start') starts.add(stepKey(event.data.turn, event.data.step))
    if (event.type === 'step/end') ends.add(stepKey(event.data.turn, event.data.step))
  }
  return { starts, ends }
}

/**
 * Map an undo-shell step lifecycle onto the source (turn, step) so Chat can
 * open assistant-step after tip filtering destroyed the original chrome.
 * Skip when that pair already has chrome in `next` (no double-count).
 */
function remapUndoShellStep(
  event: SessionEvent,
  range: { readonly startSeq: number, readonly endSeq: number },
  events: readonly SessionEvent[],
  bySeq: ReadonlyMap<number, SessionEvent>,
  present: { readonly starts: Set<string>, readonly ends: Set<string> },
): SessionEvent | null {
  if (event.type !== 'step/start' && event.type !== 'step/end') return null
  let coords: { turn: number, step: number } | undefined
  for (const candidate of events) {
    const seq = Number(candidate.seq)
    if (seq < range.startSeq || seq > range.endSeq) continue
    if (!isUndoCopyEvent(candidate)) continue
    coords = sourceTurnStepOf(candidate, bySeq)
    if (coords !== undefined) break
  }
  if (coords === undefined) {
    const turn = event.data.turn
    const step = event.data.step
    coords = { turn, step }
  }
  const key = stepKey(coords.turn, coords.step)
  if (event.type === 'step/start' && present.starts.has(key)) return null
  if (event.type === 'step/end' && present.ends.has(key)) return null
  if (event.type === 'step/start') present.starts.add(key)
  else present.ends.add(key)
  if (event.data.turn === coords.turn && event.data.step === coords.step
    && surfaceOpOf(event) === 'append') {
    return event
  }
  return {
    ...asAppend(event),
    data: { ...event.data, turn: coords.turn, step: coords.step },
  } as SessionEvent
}

/**
 * ActivityPill turns/steps — always from the presented chat surface while
 * restore/undo scaffolding is in play.
 */
export function activityStatsFromEntries(
  entries: readonly SessionEventLikeEntry[],
): { readonly turns: number, readonly steps: number } {
  const presented = presentRollbackTranscript(entries)
  return activityStatsFromEvents(
    presented.flatMap(entry => entry.type === 'event' ? [entry.event] : []),
  )
}

export function filterTurnOutline(
  outline: unknown,
  hideTurnsFrom: number | undefined,
  continueAfterSeq?: number,
  omitShellRanges?: readonly { readonly startSeq: number, readonly endSeq: number }[],
): unknown {
  if (!Array.isArray(outline)) return outline
  if (hideTurnsFrom === undefined
    && (omitShellRanges === undefined || omitShellRanges.length === 0)) return outline
  const next = outline.filter(entry => {
    if (!isRecord(entry) || typeof entry.turn !== 'number') return true
    if (typeof entry.seq === 'number' && omitShellRanges !== undefined
      && inUndoShellRange(entry.seq, omitShellRanges)) return false
    if (hideTurnsFrom === undefined) return true
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
 * keep a single live restore tip as append-origin for bookkeeping (Chat hides it as
 * ordinary context — it is not a real turn), keep undo copies visible, and strip the
 * Host-only undo turn/step shell so unmask does not look like a new user round.
 *
 * Host surface replace only updates model-visible history; Chat matches append-origin
 * events only, so the Client must reshape the loaded window for UI.
 */
export function presentRollbackTranscript(
  entries: readonly SessionEventLikeEntry[],
): readonly SessionEventLikeEntry[] {
  const events = entries.flatMap(entry => entry.type === 'event' ? [entry.event] : [])
  const bySeq = new Map(events.map(event => [Number(event.seq), event]))
  const everShadowed = new Set<number>()
  const liveTip = liveTipMarker(events)
  const liveTipSeq = liveTip === undefined ? undefined : Number(liveTip.seq)
  const hideTurnsFrom = activeRollbackHideTurnsFrom(entries)
  const continueAfterSeq = activeRollbackContinueAfterSeq(entries)
  const undoRanges = undoShellRanges(events)
  for (const event of events) {
    if (!isRollbackMarkerEvent(event)) continue
    for (const seq of event.sourceEventSeqs ?? []) everShadowed.add(Number(seq))
  }
  if (everShadowed.size === 0 && liveTipSeq === undefined && undoRanges.length === 0
    && !events.some(isUndoCopyEvent)) return renumberCollidingTurns(entries)

  let changed = false
  const next: SessionEventLikeEntry[] = []
  // Track step chrome already kept so remapped undo-shell steps do not double-count.
  const presentSteps = collectStepChromeKeys([])
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
    const seq = Number(event.seq)
    const shell = undoRanges.find(range => seq >= range.startSeq && seq <= range.endSeq)
    if (shell !== undefined) {
      // Drop Host turn scaffolding + synthetic tool/call — not a real new round.
      if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'tool/call') {
        changed = true
        continue
      }
      // Remap step chrome onto the source (turn, step). Tip filtering often destroyed
      // the original step/start via eventSource.replace; without this Chat's
      // assistant-step node stays null and the model reply vanishes.
      if (event.type === 'step/start' || event.type === 'step/end') {
        const remapped = remapUndoShellStep(event, shell, events, bySeq, presentSteps)
        changed = true
        if (remapped === null) continue
        next.push({ type: 'event', event: remapped })
        continue
      }
    }
    // Drop rolled-back turn chrome / leftovers before the restore tip only.
    // Continuation turns after the tip often reuse turn numbers >= hideTurnsFrom;
    // hiding those would blank the new model reply.
    const beforeTip = continueAfterSeq === undefined || seq <= continueAfterSeq
    if (hideTurnsFrom !== undefined && ownedTurn !== undefined && ownedTurn >= hideTurnsFrom
      && beforeTip && !isRollbackMarkerEvent(event) && !isUndoCopyEvent(event)) {
      changed = true
      continue
    }
    if (event.type === 'step/start') {
      presentSteps.starts.add(stepKey(event.data.turn, event.data.step))
    } else if (event.type === 'step/end') {
      presentSteps.ends.add(stepKey(event.data.turn, event.data.step))
    }
    if (isRollbackMarkerEvent(event)) {
      // Older tips: drop. Live tip: keep only for bookkeeping — Chat hides context.
      if (liveTipSeq === undefined || Number(event.seq) !== liveTipSeq) {
        changed = true
        continue
      }
      const tip = asBookkeepingTip(event)
      if (tip === event && surfaceOpOf(event) === 'append') {
        next.push(entry)
        continue
      }
      next.push({ type: 'event', event: tip })
      changed = true
      continue
    }
    if (isUndoCopyEvent(event)) {
      const displayed = asUnmaskedUndoCopy(event, bySeq)
      if (displayed === event) {
        next.push(entry)
        continue
      }
      next.push({ type: 'event', event: displayed })
      changed = true
      continue
    }
    next.push(entry)
  }
  return renumberCollidingTurns(changed ? next : entries)
}
