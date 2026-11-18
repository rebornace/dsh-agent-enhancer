import { describe, expect, it } from 'vitest'
import { AUTO_PROVIDER, AUTO_MODEL, isAutoSelection } from '../src/host/auto-route/sentinel.ts'
import { pickTierHeuristic, scoreHeuristic } from '../src/host/auto-route/heuristic.ts'

describe('auto sentinel', () => {
  it('detects auto selection', () => {
    expect(isAutoSelection({ provider: AUTO_PROVIDER, model: AUTO_MODEL })).toBe(true)
    expect(isAutoSelection({ provider: '', model: '' })).toBe(false)
    expect(isAutoSelection({ provider: 'deepseek', model: 'deepseek-chat' })).toBe(false)
  })
})

describe('pickTierHeuristic', () => {
  it('maps short plain prompts to instant (zh/en)', () => {
    expect(pickTierHeuristic({ text: 'hi', feature: 'predict' })).toBe('instant')
    expect(pickTierHeuristic({ text: '你好', feature: 'predict' })).toBe('instant')
    expect(pickTierHeuristic({ text: '把变量改名', feature: 'session' })).toBe('instant')
  })

  it('maps compact feature toward thinking', () => {
    expect(pickTierHeuristic({ text: '', feature: 'compact' })).toBe('thinking')
  })

  it('raises tool-heavy turns above instant', () => {
    expect(pickTierHeuristic({ text: 'ok', feature: 'session', toolHeavy: true })).toBe('thinking')
  })

  it('maps English debug / Chinese 根因 cues above instant', () => {
    expect(pickTierHeuristic({
      text: 'Please analyze the root cause of this deadlock in the worker pool.',
      feature: 'session',
    })).toBe('thinking')
    expect(pickTierHeuristic({
      text: '请排查这个并发死锁的根因，并给出修复方案。',
      feature: 'session',
    })).toBe('thinking')
  })

  it('maps long + depth cues to pro (zh)', () => {
    expect(pickTierHeuristic({
      text: '请深入分析并仔细推理以下长文：' + 'x'.repeat(800),
      feature: 'optimize',
    })).toBe('pro')
  })

  it('floors a single sensitive topic at thinking', () => {
    expect(pickTierHeuristic({
      text: 'check this production config value',
      feature: 'session',
    })).toBe('thinking')
    expect(pickTierHeuristic({
      text: '帮我改一下这串密钥的读取路径',
      feature: 'session',
    })).toBe('thinking')
  })

  it('floors two sensitive topics at pro', () => {
    expect(pickTierHeuristic({
      text: 'rotate the production API key carefully',
      feature: 'session',
    })).toBe('pro')
    expect(pickTierHeuristic({
      text: '生产环境 billing 密钥泄露后如何止血',
      feature: 'session',
    })).toBe('pro')
  })

  it('treats code fences / stacks as complexity (en)', () => {
    const tier = pickTierHeuristic({
      text: [
        'Fix this crash:',
        '```ts',
        'export function boom() { throw new TypeError("bad") }',
        '```',
        'TypeError: bad',
        '    at boom (src/a.ts:1:20)',
      ].join('\n'),
      feature: 'session',
    })
    expect(tier === 'thinking' || tier === 'pro').toBe(true)
  })
})

describe('scoreHeuristic', () => {
  it('exposes raise-only floors and bilingual signals', () => {
    const scored = scoreHeuristic({
      text: '请深入分析生产环境的死锁根因',
      feature: 'session',
      toolHeavy: true,
    })
    expect(scored.tier).not.toBe('instant')
    expect(scored.floor).not.toBe('instant')
    expect(scored.signals.some(signal => signal.startsWith('depth') || signal === 'floor-tools')).toBe(true)
  })
})
