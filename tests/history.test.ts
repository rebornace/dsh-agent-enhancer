import { describe, expect, it } from 'vitest'
import { PromptHistory } from '../src/client/prompt/history.ts'

describe('PromptHistory', () => {
  it('returns null for every navigation in an empty history', () => {
    const history = new PromptHistory([])

    expect(history.previous(null)).toBeNull()
    expect(history.previous(0)).toBeNull()
    expect(history.next(0)).toBeNull()
    expect(history.search('')).toEqual([])
  })

  it('starts at the newest entry, stops at the oldest, and returns toward the draft', () => {
    const history = new PromptHistory([
      { seq: 1, text: 'oldest' },
      { seq: 3, text: 'newest' },
      { seq: 2, text: 'middle' },
    ])

    expect(history.previous(null)).toEqual({ text: 'newest', index: 0 })
    expect(history.previous(0)).toEqual({ text: 'middle', index: 1 })
    expect(history.previous(1)).toEqual({ text: 'oldest', index: 2 })
    expect(history.previous(2)).toEqual({ text: 'oldest', index: 2 })
    expect(history.next(2)).toEqual({ text: 'middle', index: 1 })
    expect(history.next(1)).toEqual({ text: 'newest', index: 0 })
    expect(history.next(0)?.index).toBeNull()
  })

  it('deduplicates sequence numbers before navigation and search', () => {
    const history = new PromptHistory([
      { seq: 2, text: 'newer' },
      { seq: 1, text: 'older' },
      { seq: 2, text: 'duplicate' },
    ])

    expect(history.previous(null)).toEqual({ text: 'newer', index: 0 })
    expect(history.previous(0)).toEqual({ text: 'older', index: 1 })
    expect(history.previous(1)).toEqual({ text: 'older', index: 1 })
    expect(history.search('')).toEqual([{ seq: 2, text: 'newer' }, { seq: 1, text: 'older' }])
  })

  it('searches case-insensitively and treats whitespace as an empty query', () => {
    const history = new PromptHistory([
      { seq: 1, text: 'Deploy API' },
      { seq: 2, text: 'Write tests' },
      { seq: 3, text: 'api review' },
    ])

    expect(history.search('API')).toEqual([
      { seq: 3, text: 'api review' },
      { seq: 1, text: 'Deploy API' },
    ])
    expect(history.search('  \n')).toEqual([
      { seq: 3, text: 'api review' },
      { seq: 2, text: 'Write tests' },
      { seq: 1, text: 'Deploy API' },
    ])
    expect(history.search('missing')).toEqual([])
  })
})
