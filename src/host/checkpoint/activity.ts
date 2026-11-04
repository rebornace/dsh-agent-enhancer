import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { isRollbackId, isUndoId } from '../../identity.ts'

export interface UndoShellRange {
  readonly turn: number
  readonly startSeq: number
  readonly endSeq: number
}

export interface LiveActivityStats {
  /** Distinct turns with at least one closed step on the live surface. */
  readonly turns: number
  /** Closed steps (`step/end`) on the live surface — matches sessionStats. */
  readonly steps: number
  /** Restorable checkpoints exposed in the timeline (undo-shell captures excluded). */
  readonly checkpoints: number
  /** Checkpoints not currently hidden by the live restore tip. */
  readonly liveCheckpoints: number
}

function surfaceMessageId(event: SessionEvent): string | null {
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

export function isUndoCopyEvent(event: SessionEvent): boolean {
  const id = surfaceMessageId(event)
  return id !== null && isUndoId(id)
}

/** Tip / rollback notices — scaffolding, never a human turn prompt. */
export function isRollbackScaffoldEvent(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  if (isRollbackId(event.data.id)) return true
  return event.data.source.kind === 'checkpoint-rollback'
}

/**
 * Seq ranges for Host undo turn/step shells. Key by seq (not turn id): a later
 * real prompt may reuse the shell's turn number after lastTurn re-sync.
 */
export function undoShellRanges(
  events: readonly SessionEvent[],
): readonly UndoShellRange[] {
  const ranges: UndoShellRange[] = []
  let turn: number | undefined
  let startSeq = 0
  let sawUndo = false
  let sawReal = false
  let lastSeq = 0
  const flush = () => {
    if (turn !== undefined && sawUndo && !sawReal) {
      ranges.push({ turn, startSeq, endSeq: lastSeq })
    }
    sawUndo = false
    sawReal = false
  }
  for (const event of events) {
    lastSeq = Number(event.seq)
    if (event.type === 'turn/start') {
      flush()
      turn = event.data.turn
      startSeq = lastSeq
      continue
    }
    if (event.type === 'turn/end' && turn !== undefined && event.data.turn === turn) {
      flush()
      turn = undefined
      continue
    }
    if (turn === undefined || isRollbackScaffoldEvent(event)) continue
    if (isUndoCopyEvent(event)) {
      sawUndo = true
      continue
    }
    if (event.type === 'user/message' || event.type === 'assistant/message'
      || event.type === 'tool/result' || event.type === 'system/message'
      || event.type === 'developer/message') {
      sawReal = true
    }
  }
  flush()
  return ranges
}

export function inUndoShellRange(
  seq: number,
  ranges: readonly Pick<UndoShellRange, 'startSeq' | 'endSeq'>[],
): boolean {
  return ranges.some(range => seq >= range.startSeq && seq <= range.endSeq)
}

/**
 * True when a stored checkpoint was captured from an undo-shell turn.
 * Match by turnStart seq (`atSeq + 1`), never by turn number alone.
 */
export function isUndoShellCheckpoint(
  atSeq: number,
  ranges: readonly UndoShellRange[],
): boolean {
  const turnStartSeq = atSeq + 1
  return ranges.some(range => turnStartSeq >= range.startSeq && turnStartSeq <= range.endSeq)
}

function turnOfEvent(event: SessionEvent): number | undefined {
  if (event.type === 'turn/start' || event.type === 'turn/end'
    || event.type === 'step/start' || event.type === 'step/end') {
    return event.data.turn
  }
  const turn = (event.data as { turn?: unknown }).turn
  return typeof turn === 'number' ? turn : undefined
}

/**
 * Own surface activity for timeline / gauge — not Host whole-log.
 * Count closed `step/end` (and their turns). Exclude undo-shell scaffolding,
 * tip-hidden turns, and seqs withdrawn by restore markers so 轮/步 track the
 * same surface the composer ActivityPill shows after presentRollbackTranscript.
 */
export function liveActivityStats(
  events: readonly SessionEvent[],
  options: {
    readonly hideTurnsFrom?: number
    readonly continueAfterSeq?: number
    readonly checkpointCount: number
    readonly liveCheckpointCount: number
  },
): LiveActivityStats {
  const ranges = undoShellRanges(events)
  const everShadowed = new Set<number>()
  for (const event of events) {
    if (!isRollbackScaffoldEvent(event)) continue
    for (const seq of event.sourceEventSeqs ?? []) everShadowed.add(Number(seq))
  }
  const closed = new Set<string>()
  const turns = new Set<number>()

  for (const event of events) {
    if (event.type !== 'step/end') continue
    const seq = Number(event.seq)
    if (everShadowed.has(seq)) continue
    // Undo-shell step/end may be remapped onto the source (turn, step) by the
    // client presenter; Host timeline counts the live tip window only and skips
    // raw shell ranges so scaffolding never inflates 轮/步.
    if (inUndoShellRange(seq, ranges)) continue
    const beforeTip = options.continueAfterSeq === undefined
      || seq <= options.continueAfterSeq
    const turn = event.data.turn
    if (options.hideTurnsFrom !== undefined && turn >= options.hideTurnsFrom && beforeTip) {
      continue
    }
    const key = `${turn}:${event.data.step}`
    if (closed.has(key)) continue
    closed.add(key)
    turns.add(turn)
  }

  if (closed.size === 0) {
    // Fixtures / truncated windows without step chrome — approximate from turns
    // and assistant rows that would still be live under the same tip filter.
    let steps = 0
    for (const event of events) {
      const seq = Number(event.seq)
      if (inUndoShellRange(seq, ranges)) continue
      if (isRollbackScaffoldEvent(event)) continue
      const beforeTip = options.continueAfterSeq === undefined
        || seq <= options.continueAfterSeq
      const ownedTurn = turnOfEvent(event)
      if (options.hideTurnsFrom !== undefined && ownedTurn !== undefined
        && ownedTurn >= options.hideTurnsFrom && beforeTip
        && !isUndoCopyEvent(event)) {
        continue
      }
      if (event.type === 'turn/start') {
        turns.add(event.data.turn)
        continue
      }
      if (event.type === 'assistant/message') {
        steps += 1
        if (ownedTurn !== undefined) turns.add(ownedTurn)
      }
    }
    return {
      turns: turns.size,
      steps,
      checkpoints: options.checkpointCount,
      liveCheckpoints: options.liveCheckpointCount,
    }
  }

  return {
    turns: turns.size,
    steps: closed.size,
    checkpoints: options.checkpointCount,
    liveCheckpoints: options.liveCheckpointCount,
  }
}
