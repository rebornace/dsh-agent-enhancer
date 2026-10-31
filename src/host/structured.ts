import { AuxiliaryError } from '../errors.ts'
import type { OptimizeReference } from './types.ts'

const PLACEHOLDER_PREFIX = '__DSH_REF_'

export interface MaskedReferences {
  readonly source: string
  readonly placeholders: readonly string[]
}
export interface UnmaskedReferences {
  readonly text: string
  readonly segments: readonly string[]
}

function invalidOutput(): never {
  throw new AuxiliaryError('INVALID_OUTPUT')
}

export function maskReferences(
  source: string,
  references: readonly OptimizeReference[],
): MaskedReferences {
  if (source.includes(PLACEHOLDER_PREFIX)) invalidOutput()
  const chunks: string[] = []
  const placeholders: string[] = []
  let previousEnd = 0
  for (const [index, reference] of references.entries()) {
    if (!Number.isInteger(reference.offset) || reference.offset < previousEnd ||
      !Number.isInteger(reference.length) || reference.length <= 0 ||
      source.slice(reference.offset, reference.offset + reference.length) !== reference.text) {
      invalidOutput()
    }
    const placeholder = `__DSH_REF_${index + 1}__`
    chunks.push(source.slice(previousEnd, reference.offset), placeholder)
    placeholders.push(placeholder)
    previousEnd = reference.offset + reference.length
  }
  chunks.push(source.slice(previousEnd))
  return { source: chunks.join(''), placeholders }
}

export function unmaskReferences(
  text: string,
  placeholders: readonly string[],
  references: readonly OptimizeReference[],
): UnmaskedReferences {
  if (placeholders.length !== references.length) invalidOutput()
  const segments: string[] = []
  let previousEnd = 0
  for (const placeholder of placeholders) {
    const offset = text.indexOf(placeholder, previousEnd)
    if (offset === -1) invalidOutput()
    const segment = text.slice(previousEnd, offset)
    if (segment.includes(PLACEHOLDER_PREFIX)) invalidOutput()
    segments.push(segment)
    previousEnd = offset + placeholder.length
  }
  const finalSegment = text.slice(previousEnd)
  if (finalSegment.includes(PLACEHOLDER_PREFIX)) invalidOutput()
  segments.push(finalSegment)
  let restored = segments[0]!
  for (const [index, reference] of references.entries()) {
    restored += reference.text + segments[index + 1]!
  }
  return { text: restored, segments }
}
