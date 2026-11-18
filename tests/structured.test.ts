import type { InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { describe, expect, it } from 'vitest'
import { replaceAroundOccurrences, textSegments } from '../src/client/dsh/structured.ts'

type Occurrence = InputState['occurrences'][number]

const source = 'a@x b@y c'
const occurrences: readonly Occurrence[] = [
  { occurrenceId: 1, source: 'file', ref: 'x', offset: 1, length: 2, label: 'x', clipboardText: '@x' },
  { occurrenceId: 2, source: 'file', ref: 'y', offset: 5, length: 2, label: 'y', clipboardText: '@y' },
]

interface Span {
  readonly start: number
  readonly end: number
  readonly draftRev: number
}

function actionsFixture(failAt?: number, failWrites: readonly number[] = []) {
  let draft = source
  let detectDraft = 'a\uFFFC b\uFFFC c'
  let draftRev = 1
  let persists = 0
  let setDrafts = 0
  let submits = 0
  let writes = 0
  const spans: Array<Span & { text: string }> = []
  const currentOccurrences = occurrences.map(occurrence => ({ ...occurrence }))
  const clipboardOffset = (offset: number): number => {
    let result = offset
    let expansion = 0
    for (const occurrence of currentOccurrences) {
      if (offset <= occurrence.offset - expansion) break
      result += occurrence.length - 1
      expansion += occurrence.length - 1
    }
    return result
  }
  const actions = {
    captureInsertion: (): Span => ({ start: 0, end: 0, draftRev }),
    insertText(text: string, span: Span): boolean {
      spans.push({ text, ...span })
      writes += 1
      if (writes === failAt || failWrites.includes(writes) || span.draftRev !== draftRev || span.start < 0 ||
        span.end < span.start || span.end > detectDraft.length) return false
      const clipboardStart = clipboardOffset(span.start)
      const clipboardEnd = clipboardOffset(span.end)
      draft = draft.slice(0, clipboardStart) + text + draft.slice(clipboardEnd)
      detectDraft = detectDraft.slice(0, span.start) + text + detectDraft.slice(span.end)
      const shift = text.length - (clipboardEnd - clipboardStart)
      for (const occurrence of currentOccurrences) {
        if (occurrence.offset >= clipboardStart) occurrence.offset += shift
      }
      draftRev += 1
      return true
    },
    setDraft(): void { setDrafts += 1 },
    persistDraft(): void { persists += 1 },
    submit(): void { submits += 1 },
  } as unknown as InputActions
  return {
    actions,
    spans,
    draft: () => draft,
    persists: () => persists,
    forbiddenWrites: () => setDrafts + submits,
  }
}

describe('structured draft transactions', () => {
  it('replaces Host text segments from tail to head without touching chips', () => {
    const h = actionsFixture()

    expect(textSegments(source, occurrences)).toEqual(['a', ' b', ' c'])
    expect(replaceAroundOccurrences(h.actions, source, occurrences, ['A', 'B', 'C'])).toBe(true)

    expect(h.draft()).toBe('A@xB@yC')
    expect(h.spans).toEqual([
      { text: 'C', start: 5, end: 7, draftRev: 1 },
      { text: 'B', start: 2, end: 4, draftRev: 2 },
      { text: 'A', start: 0, end: 1, draftRev: 3 },
    ])
    expect(h.persists()).toBe(1)
    expect(h.forbiddenWrites()).toBe(0)
  })

  it('deletes an empty trailing segment using official detect coordinates', () => {
    const h = actionsFixture()

    expect(replaceAroundOccurrences(h.actions, source, occurrences, ['A', 'B', ''])).toBe(true)

    expect(h.draft()).toBe('A@xB@y')
    expect(h.spans[0]).toEqual({ text: '', start: 5, end: 7, draftRev: 1 })
  })

  it('does not write when the Host segment count does not match the occurrences', () => {
    const h = actionsFixture()

    expect(replaceAroundOccurrences(h.actions, source, occurrences, ['A', 'B'])).toBe(false)

    expect(h.draft()).toBe(source)
    expect(h.spans).toEqual([])
    expect(h.persists()).toBe(0)
    expect(h.forbiddenWrites()).toBe(0)
  })

  it('synchronously rolls back applied segments after a CAS failure', () => {
    const h = actionsFixture(2)

    expect(replaceAroundOccurrences(h.actions, source, occurrences, ['A', 'B', 'C'])).toBe(false)

    expect(h.draft()).toBe(source)
    expect(h.spans).toEqual([
      { text: 'C', start: 5, end: 7, draftRev: 1 },
      { text: 'B', start: 2, end: 4, draftRev: 2 },
      { text: ' c', start: 5, end: 6, draftRev: 2 },
    ])
    expect(h.persists()).toBe(0)
    expect(h.forbiddenWrites()).toBe(0)
  })

  it('rolls back multiple shifted segments at their current positions', () => {
    const h = actionsFixture(3)

    expect(replaceAroundOccurrences(h.actions, source, occurrences, ['A', 'B', 'C'])).toBe(false)

    expect(h.spans).toEqual([
      { text: 'C', start: 5, end: 7, draftRev: 1 },
      { text: 'B', start: 2, end: 4, draftRev: 2 },
      { text: 'A', start: 0, end: 1, draftRev: 3 },
      { text: ' c', start: 4, end: 5, draftRev: 3 },
      { text: ' b', start: 2, end: 3, draftRev: 4 },
    ])
    expect(h.draft()).toBe(source)
    expect(h.persists()).toBe(0)
    expect(h.forbiddenWrites()).toBe(0)
  })

  it('keeps the original draft when writes fail continuously before any apply', () => {
    const h = actionsFixture(undefined, [1, 2, 3])

    expect(replaceAroundOccurrences(h.actions, source, occurrences, ['A', 'B', 'C'])).toBe(false)

    expect(h.draft()).toBe(source)
    expect(h.persists()).toBe(0)
  })

  it('reports a rollback failure and exposes the partially applied draft', () => {
    const h = actionsFixture(undefined, [2, 3])

    expect(() => replaceAroundOccurrences(h.actions, source, occurrences, ['A', 'B', 'C']))
      .toThrowError(expect.objectContaining({ code: 'ROLLBACK_FAILED' }))

    expect(h.draft()).toBe('a@x b@yC')
    expect(h.persists()).toBe(0)
    expect(h.forbiddenWrites()).toBe(0)
  })
})
