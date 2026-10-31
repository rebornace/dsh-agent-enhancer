import { describe, expect, it } from 'vitest'
import { maskReferences, unmaskReferences } from '../src/host/structured.ts'
import type { OptimizeReference } from '../src/host/types.ts'

const source = '帮助 @a.ts 分析 @b.ts 并总结'
const references: readonly OptimizeReference[] = [
  { offset: 3, length: 5, text: '@a.ts' },
  { offset: 12, length: 5, text: '@b.ts' },
]
const placeholders = ['__DSH_REF_1__', '__DSH_REF_2__']

function expectInvalid(run: () => unknown): void {
  expect(run).toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT' }))
}

describe('Host reference masking', () => {
  it('masks exact source ranges and restores chips using only placeholder boundaries', () => {
    expect(maskReferences(source, references)).toEqual({
      source: '帮助 __DSH_REF_1__ 分析 __DSH_REF_2__ 并总结',
      placeholders,
    })
    expect(unmaskReferences(
      '请检查 __DSH_REF_1__ 和 __DSH_REF_2__，保留 @a.ts 字面量',
      placeholders,
      references,
    )).toEqual({
      text: '请检查 @a.ts 和 @b.ts，保留 @a.ts 字面量',
      segments: ['请检查 ', ' 和 ', '，保留 @a.ts 字面量'],
    })
  })

  it('returns ordinary output as one segment when there are no references', () => {
    expect(unmaskReferences('普通文本', [], [])).toEqual({ text: '普通文本', segments: ['普通文本'] })
  })

  it.each([
    ['out of order', source, [...references].reverse()],
    ['overlapping', 'abcd', [
      { offset: 0, length: 2, text: 'ab' },
      { offset: 1, length: 2, text: 'bc' },
    ]],
    ['offset mismatch', source, [references[0]!, { ...references[1]!, offset: 13 }]],
    ['text mismatch', source, [{ ...references[0]!, text: '@b.ts' }, references[1]!]],
    ['source placeholder collision', '普通 __DSH_REF_9__ 文本', []],
  ])('rejects %s references', (_name, input, invalidReferences) => {
    expectInvalid(() => maskReferences(input, invalidReferences))
  })

  it.each([
    ['missing', '只保留 __DSH_REF_1__'],
    ['duplicated', '__DSH_REF_1__ __DSH_REF_2__ __DSH_REF_2__'],
    ['renamed', '__DSH_REF_1__ __DSH_REF_02__'],
    ['reordered', '__DSH_REF_2__ __DSH_REF_1__'],
    ['extra', '__DSH_REF_1__ __DSH_REF_2__ __DSH_REF_3__'],
  ])('rejects %s model placeholders', (_name, text) => {
    expectInvalid(() => unmaskReferences(text, placeholders, references))
  })

  it('rejects a forged placeholder even when no references were sent', () => {
    expectInvalid(() => unmaskReferences('伪造 __DSH_REF_1__', [], []))
  })
})
