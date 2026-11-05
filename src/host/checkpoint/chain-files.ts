import type { FileCheckpoint } from './types.ts'
import type { Checkpoint } from './types.ts'

/**
 * Net change from the start of a multi-turn restore chain to its end.
 * `earliest` is the first touch in the withdrawn range; `latest` is the last.
 *
 * Create-then-delete within the same chain is a net no-op (absent → absent) and
 * must not be classified as `create` with a null after-image — that fails
 * validation and blocks restoring sibling deletes/creates in the same preview.
 */
export function netFileChange(
  earliest: FileCheckpoint,
  latest: FileCheckpoint,
): FileCheckpoint['change'] | null {
  if (earliest.beforeText === null && latest.afterText === null) return null
  if (earliest.beforeText === null) return 'create'
  if (latest.afterText === null) return 'delete'
  return 'modify'
}

export interface ChainTrackedFilesRange {
  /** Inclusive lower bound by turn number (legacy / tests). */
  readonly fromTurn: number
  /** Exclusive upper bound by turn number. */
  readonly untilTurnExclusive?: number
  /**
   * Prefer these when present: turn numbers reuse after undo, so atSeq is the
   * stable restore pin (same value as the cut's `cutSeq` for that tip).
   */
  readonly fromAtSeq?: number
  readonly untilAtSeqExclusive?: number
}

/**
 * Collapse checkpoints in the restore window into one FileCheckpoint per path.
 *
 * Restoring only the target turn's files leaves later tracked edits on disk.
 * For each path we keep the earliest `before*` (state before the chain) and the
 * latest `after*` (what must match disk before rollback / what undo writes back).
 *
 * When a live cut already sits at a later tip, pass that tip as the exclusive
 * upper bound so already-restored turns are not verified/restored again.
 */
export function chainTrackedFiles(
  checkpoints: readonly Checkpoint[],
  fromTurnOrRange: number | ChainTrackedFilesRange,
  untilTurnExclusive?: number,
): readonly FileCheckpoint[] {
  const range: ChainTrackedFilesRange = typeof fromTurnOrRange === 'number'
    ? { fromTurn: fromTurnOrRange, untilTurnExclusive }
    : fromTurnOrRange
  if (!Number.isFinite(range.fromTurn) && range.fromAtSeq === undefined) return []
  const inRange = checkpoints
    .filter(checkpoint => {
      if (range.fromAtSeq !== undefined) {
        if (checkpoint.atSeq < range.fromAtSeq) return false
        if (range.untilAtSeqExclusive !== undefined && checkpoint.atSeq >= range.untilAtSeqExclusive) {
          return false
        }
        return true
      }
      return checkpoint.turn >= range.fromTurn
        && (range.untilTurnExclusive === undefined || checkpoint.turn < range.untilTurnExclusive)
    })
    .slice()
    .sort((left, right) => left.atSeq - right.atSeq || left.turn - right.turn)

  const byPath = new Map<string, { earliest: FileCheckpoint, latest: FileCheckpoint }>()
  for (const checkpoint of inRange) {
    for (const file of checkpoint.files) {
      const previous = byPath.get(file.path)
      if (previous === undefined) {
        byPath.set(file.path, { earliest: file, latest: file })
        continue
      }
      byPath.set(file.path, { earliest: previous.earliest, latest: file })
    }
  }

  const chained: FileCheckpoint[] = []
  for (const { earliest, latest } of byPath.values()) {
    const change = netFileChange(earliest, latest)
    if (change === null) continue
    chained.push({
      path: earliest.path,
      change,
      beforeText: earliest.beforeText,
      beforeHash: earliest.beforeHash,
      afterText: latest.afterText,
      afterHash: latest.afterHash,
    })
  }
  return chained
}
