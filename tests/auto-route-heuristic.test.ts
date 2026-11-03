import { describe, expect, it } from 'vitest'
import { AUTO_PROVIDER, AUTO_MODEL, isAutoSelection } from '../src/host/auto-route/sentinel.ts'
import { pickTierHeuristic } from '../src/host/auto-route/heuristic.ts'

describe('auto sentinel', () => {
  it('detects auto selection', () => {
    expect(isAutoSelection({ provider: AUTO_PROVIDER, model: AUTO_MODEL })).toBe(true)
    expect(isAutoSelection({ provider: '', model: '' })).toBe(false)
    expect(isAutoSelection({ provider: 'deepseek', model: 'deepseek-chat' })).toBe(false)
  })
})

describe('pickTierHeuristic', () => {
  it('maps short plain prompts to instant', () => {
    expect(pickTierHeuristic({ text: 'hi', feature: 'predict' })).toBe('instant')
  })
  it('maps compact feature toward thinking', () => {
    expect(pickTierHeuristic({ text: '', feature: 'compact' })).toBe('thinking')
  })
  it('maps long + depth cues to pro', () => {
    expect(pickTierHeuristic({
      text: '请深入分析并仔细推理以下长文：' + 'x'.repeat(800),
      feature: 'optimize',
    })).toBe('pro')
  })
})
