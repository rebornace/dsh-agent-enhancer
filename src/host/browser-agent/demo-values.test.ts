import { describe, expect, it } from 'vitest'
import type { DemoStep } from './demo.ts'
import {
  isDateVariable,
  resolveDatePhrase,
  resolveVariableValue,
  suggestRecipeVariables,
} from './demo-values.ts'
import { prepareRecipeValues, matchRecipeVarValues } from './demo-recipes.ts'

// 2026-11-20 is a Friday.
const NOW = new Date(2026, 10, 20, 15, 30)

describe('resolveDatePhrase', () => {
  const cases: Array<[string, string]> = [
    ['今天', '2026-11-20'],
    ['昨天', '2026-11-19'],
    ['前天', '2026-11-18'],
    ['明天', '2026-11-21'],
    ['本周', '2026-11-16'],
    ['上周', '2026-11-09'],
    ['下周', '2026-11-23'],
    ['周一', '2026-11-16'],
    ['上周五', '2026-11-13'],
    ['星期日', '2026-11-22'],
    ['礼拜三', '2026-11-18'],
    ['本月', '2026-11-01'],
    ['上个月', '2026-10-01'],
    ['下个月', '2026-12-01'],
    ['本季度', '2026-10-01'],
    ['上季度', '2026-07-01'],
    ['今年', '2026-01-01'],
    ['去年', '2025-01-01'],
    ['2026/3/5', '2026-03-05'],
    ['2026年3月5日', '2026-03-05'],
  ]
  for (const [phrase, expected] of cases) {
    it(`reads ${phrase}`, () => {
      expect(resolveDatePhrase(phrase, NOW)?.iso).toBe(expected)
    })
  }

  it('leaves ordinary text alone', () => {
    expect(resolveDatePhrase('上周的新闻', NOW)).toBeNull()
    expect(resolveDatePhrase('咖啡', NOW)).toBeNull()
    expect(resolveDatePhrase('', NOW)).toBeNull()
  })

  it('only resolves date-ish variables', () => {
    expect(resolveVariableValue('上周', true, NOW)).toEqual({ value: '2026-11-09', resolvedFrom: '上周' })
    expect(resolveVariableValue('上周', false, NOW)).toEqual({ value: '上周' })
    expect(resolveVariableValue('咖啡', true, NOW)).toEqual({ value: '咖啡' })
  })

  it('spots a date variable from its label or default', () => {
    expect(isDateVariable({ name: 'v1', label: '开始日期' })).toBe(true)
    expect(isDateVariable({ name: 'v2', label: '关键词', default: '2026-11-01' })).toBe(true)
    expect(isDateVariable({ name: 'v3', label: '关键词', default: '咖啡' })).toBe(false)
  })
})

describe('values from labels or ids', () => {
  const recipe = {
    variables: [
      { name: 'v1', label: '开始日期', default: '2026-11-01' },
      { name: 'v2', label: '关键词', default: '周报' },
    ],
  }

  it('accepts either the label or the id', () => {
    expect(matchRecipeVarValues(recipe, { 开始日期: '2026-10-01' }).values).toEqual({ v1: '2026-10-01' })
    expect(matchRecipeVarValues(recipe, { v1: '2026-10-01' }).values).toEqual({ v1: '2026-10-01' })
    expect(matchRecipeVarValues(recipe, { nope: 'x' }).unknown).toEqual(['nope'])
  })

  it('fills defaults, resolves dates and reports what is missing', () => {
    const prepared = prepareRecipeValues(recipe, { 开始日期: '上周' }, NOW)
    expect(prepared.values).toEqual({ v1: '2026-11-09', v2: '周报' })
    expect(prepared.resolved).toEqual([{ label: '开始日期', from: '上周', to: '2026-11-09' }])
    expect(prepared.missing).toEqual([])
    expect(prepareRecipeValues(recipe, { 关键词: '' }, NOW).missing.map(item => item.label)).toEqual(['关键词'])
  })
})

describe('suggestRecipeVariables', () => {
  const fill = (name: string, value: string, at = 1, masked = false): DemoStep => ({
    kind: 'fill', at, role: 'textbox', name, selector: '#f', field: name, value, masked,
  })

  it('suggests dates, e-mails and search terms', () => {
    const suggestions = suggestRecipeVariables([
      fill('开始日期', '2026-11-01', 1),
      fill('收件人', 'me@example.com', 2),
      fill('搜索', '季度报表', 3),
      fill('备注', '随便写点什么', 4),
      fill('密码', '***', 5, true),
    ])
    expect(suggestions.map(item => item.label)).toEqual(['开始日期', '收件人', '搜索'])
    expect(suggestions[0]).toMatchObject({ index: 0, value: '2026-11-01' })
  })

  it('never suggests more than three and skips placeholders', () => {
    const suggestions = suggestRecipeVariables([
      fill('a', '2026-11-01', 1),
      fill('b', '2026-11-02', 2),
      fill('c', '2026-11-03', 3),
      fill('d', '2026-11-04', 4),
      fill('e', '${v1}', 5),
    ])
    expect(suggestions).toHaveLength(3)
    expect(suggestions.some(item => item.value.includes('${'))).toBe(false)
  })
})
