import { describe, expect, it } from 'vitest'
import type { DemoStep } from './demo.ts'
import {
  DemoRepairTracker,
  applyHealProposal,
  buildHealProposal,
  createRepairHooks,
  describeHealProposal,
  type DemoObservedAction,
} from './demo-heal.ts'
import { DemoRecipeStore } from './demo-recipes.ts'

const clickStep = (name: string, selector = '#old'): DemoStep => ({
  kind: 'click', at: 1, role: 'button', name, selector,
})
const fillStep = (name: string, value: string, masked = false): DemoStep => ({
  kind: 'fill', at: 2, role: 'textbox', name, selector: '#date', field: 'from', value, masked,
})
const observedClick = (name: string, selector = '#new', at = 10): DemoObservedAction => ({
  kind: 'click', role: 'button', name, selector, at,
})
const observedFill = (name: string, value: string, at = 10): DemoObservedAction => ({
  kind: 'fill', role: 'textbox', name, selector: '#new-date', field: 'from', value, at,
})

describe('buildHealProposal', () => {
  it('retargets the failed control and keeps the recorded value', () => {
    const steps = [clickStep('打开报表'), fillStep('开始日期', '2026-11-01')]
    const proposal = buildHealProposal({
      steps,
      failedIndex: 1,
      reason: 'no control matching textbox "开始日期"',
      observed: [observedFill('统计开始日期', '2026-11-01')],
      now: 5_000,
    })
    expect(proposal).not.toBeNull()
    expect(proposal).toMatchObject({ failedAt: 2, at: 5_000 })
    expect(proposal?.replacement).toMatchObject({
      kind: 'fill',
      name: '统计开始日期',
      selector: '#new-date',
      value: '2026-11-01',
    })
    expect(proposal?.inserted).toEqual([])
  })

  it('keeps the steps the agent added before it found the control', () => {
    const steps = [clickStep('导出报表')]
    const proposal = buildHealProposal({
      steps,
      failedIndex: 0,
      reason: 'no control matching button "导出报表"',
      observed: [
        observedClick('同意', '#cookie', 10),
        observedClick('导出报表（新）', '#export-new', 11),
      ],
      now: 5_000,
    })
    expect(proposal?.inserted).toHaveLength(1)
    expect(proposal?.inserted[0]).toMatchObject({ kind: 'click', name: '同意' })
    expect(proposal?.replacement).toMatchObject({ name: '导出报表（新）' })
    const applied = applyHealProposal(steps, proposal!)
    expect(applied.map(step => ('name' in step ? step.name : step.kind)))
      .toEqual(['同意', '导出报表（新）'])
  })

  it('never proposes anything for a masked secret', () => {
    const steps = [fillStep('密码', '***', true)]
    expect(buildHealProposal({
      steps,
      failedIndex: 0,
      reason: 'secret field "密码" was masked; type it yourself',
      observed: [observedFill('密码', 'hunter2')],
      now: 1,
    })).toBeNull()
  })

  it('stays quiet when the control did not actually move', () => {
    const steps = [clickStep('导出')]
    expect(buildHealProposal({
      steps,
      failedIndex: 0,
      reason: 'blocked for another reason',
      observed: [observedClick('导出')],
      now: 1,
    })).toBeNull()
  })

  it('needs an action of the same kind to learn from', () => {
    const steps = [clickStep('导出')]
    expect(buildHealProposal({
      steps,
      failedIndex: 0,
      reason: 'no control',
      observed: [{ kind: 'press', key: 'Enter', at: 10 }],
      now: 1,
    })).toBeNull()
  })

  it('drops a repair that would store a secret', () => {
    const steps = [clickStep('登录')]
    const proposal = buildHealProposal({
      steps,
      failedIndex: 0,
      reason: 'no control',
      observed: [
        { kind: 'fill', role: 'textbox', name: '密码', field: 'password', selector: '#p', value: 'hunter2', at: 10 },
        observedClick('登录', '#login', 11),
      ],
      now: 1,
    })
    expect(proposal).toBeNull()
  })

  it('ignores a missing failed step', () => {
    expect(buildHealProposal({
      steps: [],
      failedIndex: 3,
      reason: 'x',
      observed: [observedClick('a')],
      now: 1,
    })).toBeNull()
  })

  it('describes itself for tool output', () => {
    const proposal = buildHealProposal({
      steps: [clickStep('导出')],
      failedIndex: 0,
      reason: 'no control',
      observed: [observedClick('同意', '#ok', 10), observedClick('导出报表', '#export', 11)],
      now: 1,
    })!
    const lines = describeHealProposal(proposal)
    expect(lines[0]).toContain('step 1 now uses')
    expect(lines[1]).toContain('+1 step(s)')
  })
})

describe('DemoRepairTracker', () => {
  it('collects actions after a stop and hands them over once', () => {
    const tracker = new DemoRepairTracker()
    expect(tracker.active).toBe(false)
    tracker.begin({ recipeId: 'r1', recipeName: '周报', index: 2, step: clickStep('导出'), reason: 'gone', at: 1_000 })
    expect(tracker.active).toBe(true)
    tracker.observe(observedClick('导出报表', '#x', 1_500))
    const taken = tracker.take()
    expect(taken?.target.index).toBe(2)
    expect(taken?.observed).toHaveLength(1)
    expect(tracker.active).toBe(false)
    expect(tracker.take()).toBeNull()
  })

  it('ignores a late observation and another tab', () => {
    const tracker = new DemoRepairTracker()
    tracker.begin({
      recipeId: 'r1', recipeName: '周报', index: 0, step: clickStep('导出'), reason: 'gone', at: 0, tabId: 3,
    })
    tracker.observe({ ...observedClick('别的', '#y', 1_000), tabId: 9 })
    tracker.observe({ ...observedClick('太晚了', '#y', 60 * 60_000), tabId: 3 })
    tracker.observe({ ...observedClick('导出报表', '#x', 2_000), tabId: 3 })
    const taken = tracker.take()
    expect(taken?.observed.map(action => action.name)).toEqual(['导出报表'])
  })

  it('ignores everything when no flow stopped', () => {
    const tracker = new DemoRepairTracker()
    tracker.observe(observedClick('导出', '#x', 10))
    expect(tracker.take()).toBeNull()
  })
})

describe('applyHealProposal', () => {
  it('replaces only the failed step', () => {
    const steps = [clickStep('a'), clickStep('b'), clickStep('c')]
    const proposal = buildHealProposal({
      steps,
      failedIndex: 1,
      reason: 'gone',
      observed: [observedClick('b2', '#b2', 10)],
      now: 1,
    })!
    expect(applyHealProposal(steps, proposal).map(step => ('name' in step ? step.name : '')))
      .toEqual(['a', 'b2', 'c'])
  })
})
