import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AuxiliaryError } from '../../errors.ts'
import type { Occurrence } from '../composer/types.ts'

export function textSegments(
  source: string,
  occurrences: readonly Occurrence[],
): readonly string[] {
  const segments: string[] = []
  let start = 0
  for (const occurrence of occurrences) {
    segments.push(source.slice(start, occurrence.offset))
    start = occurrence.offset + occurrence.length
  }
  segments.push(source.slice(start))
  return segments
}

export function detectOffset(offset: number, occurrences: readonly Occurrence[]): number {
  let result = offset
  for (const occurrence of occurrences) {
    if (offset <= occurrence.offset) break
    if (offset < occurrence.offset + occurrence.length) return -1
    result -= occurrence.length - 1
  }
  return result
}

export function replaceAroundOccurrences(
  actions: InputActions,
  source: string,
  occurrences: readonly Occurrence[],
  optimizedSegments: readonly string[],
): boolean {
  if (optimizedSegments.length !== occurrences.length + 1) return false
  const originalSegments = textSegments(source, occurrences)
  const segmentStarts: number[] = []
  const segmentEnds: number[] = []
  let start = 0
  for (let i = 0; i < originalSegments.length; i += 1) {
    const occurrence = occurrences[i]
    const end = occurrence === undefined ? source.length : occurrence.offset
    segmentStarts.push(start)
    segmentEnds.push(end)
    if (occurrence !== undefined) start = occurrence.offset + occurrence.length
  }

  for (let i = optimizedSegments.length - 1; i >= 0; i -= 1) {
    const revision = actions.captureInsertion().draftRev
    if (actions.insertText(optimizedSegments[i]!, {
      start: detectOffset(segmentStarts[i]!, occurrences),
      end: detectOffset(segmentEnds[i]!, occurrences),
      draftRev: revision,
    })) continue
    for (let j = optimizedSegments.length - 1; j > i; j -= 1) {
      let start = detectOffset(segmentStarts[j]!, occurrences)
      for (let k = i + 1; k < j; k += 1) {
        start += optimizedSegments[k]!.length - originalSegments[k]!.length
      }
      const rollbackRevision = actions.captureInsertion().draftRev
      const restored = actions.insertText(originalSegments[j]!, {
        start, end: start + optimizedSegments[j]!.length,
        draftRev: rollbackRevision,
      })
      if (!restored) throw new AuxiliaryError('ROLLBACK_FAILED')
    }
    return false
  }
  actions.persistDraft()
  return true
}
