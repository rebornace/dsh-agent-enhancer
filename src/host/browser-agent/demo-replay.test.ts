import { describe, expect, it, vi } from 'vitest'
import type { DemoStep } from './demo.ts'
import {
  matchDemoControl,
  normalizeControlName,
  replayDemoSteps,
  type DemoReplayDriver,
  type DemoReplayNode,
} from './demo-replay.ts'

const nodes: DemoReplayNode[] = [
  { ref: 1, role: 'link', name: '报表' },
  { ref: 2, role: 'textbox', name: '开始日期' },
  { ref: 3, role: 'button', name: '导出报表' },
  { ref: 4, role: 'button', name: '取消' },
]

const click = (name: string, at = 1): DemoStep => ({ kind: 'click', at, role: 'button', name, selector: '#x' })
const fill = (name: string, value: string, at = 2, masked = false): DemoStep => ({
  kind: 'fill',
  at,
  role: 'textbox',
  name,
  selector: '#f',
  field: 'q',
  value,
  masked,
})

interface Calls {
  clicks: number[]
  types: Array<[number, string]>
  presses: string[]
  navigates: string[]
  follows: number[]
}

function fakeDriver(input: {
  readonly nodes?: readonly DemoReplayNode[]
  readonly url?: string
  readonly followFails?: boolean
} = {}): { driver: DemoReplayDriver; calls: Calls } {
  const calls: Calls = { clicks: [], types: [], presses: [], navigates: [], follows: [] }
  let url = input.url ?? 'https://example.com/'
  const driver: DemoReplayDriver = {
    snapshot: vi.fn(async () => ({ url, nodes: input.nodes ?? nodes })),
    click: vi.fn(async (ref: number) => {
      calls.clicks.push(ref)
      return { url }
    }),
    type: vi.fn(async (ref: number, text: string) => {
      calls.types.push([ref, text])
      return { url }
    }),
    press: vi.fn(async (key: string) => {
      calls.presses.push(key)
      return { url }
    }),
    navigate: vi.fn(async (next: string) => {
      calls.navigates.push(next)
      url = next
      return { url }
    }),
    followTab: vi.fn(async (tabId: number) => {
      calls.follows.push(tabId)
      if (input.followFails === true) throw new Error('tab closed')
      return { url }
    }),
  }
  return { driver, calls }
}

describe('normalizeControlName', () => {
  it('ignores case, runs of whitespace and zero-width characters', () => {
    expect(normalizeControlName('  Export\u200b  report \n')).toBe('export report')
  })
})

describe('matchDemoControl', () => {
  it('prefers the same role, then the same name under another role', () => {
    expect(matchDemoControl(nodes, 'button', '导出报表')?.ref).toBe(3)
    expect(matchDemoControl(nodes, 'link', '导出报表')?.ref).toBe(3)
  })

  it('accepts a unique partial label', () => {
    expect(matchDemoControl(nodes, 'link', '报表')?.ref).toBe(1)
    expect(matchDemoControl(nodes, 'button', '取消')?.ref).toBe(4)
  })

  it('refuses when a partial label is ambiguous', () => {
    const ambiguous: DemoReplayNode[] = [
      { ref: 1, role: 'button', name: '导出报表' },
      { ref: 2, role: 'button', name: '导出图片' },
    ]
    expect(matchDemoControl(ambiguous, 'button', '导出')).toBeUndefined()
  })
})

describe('replayDemoSteps', () => {
  it('runs click, fill and Enter in order', async () => {
    const { driver, calls } = fakeDriver()
    const steps: DemoStep[] = [
      click('导出报表'),
      fill('开始日期', '2026-11-01'),
      { kind: 'press', at: 3, key: 'Enter', selector: '#q' },
    ]
    const result = await replayDemoSteps(driver, steps)
    expect(result.status).toBe('done')
    expect(calls.clicks).toEqual([3])
    expect(calls.types).toEqual([[2, '2026-11-01']])
    expect(calls.presses).toEqual(['Enter'])
    if (result.status !== 'done') throw new Error('expected done')
    expect(result.performed).toBe(3)
    expect(result.lines[0]).toContain('1. ok   click button "导出报表"')
  })

  it('does not navigate when the page is already there', async () => {
    const { driver, calls } = fakeDriver({ url: 'https://example.com/a' })
    const result = await replayDemoSteps(driver, [{ kind: 'navigate', at: 1, url: 'https://example.com/a' }])
    expect(result.status).toBe('done')
    expect(calls.navigates).toEqual([])
  })

  it('stops at a masked secret and hands back the rest', async () => {
    const { driver, calls } = fakeDriver()
    const steps: DemoStep[] = [
      click('导出报表'),
      fill('密码', '***', 2, true),
      click('取消', 3),
    ]
    const result = await replayDemoSteps(driver, steps)
    expect(result.status).toBe('blocked')
    if (result.status !== 'blocked') throw new Error('expected blocked')
    expect(result.performed).toBe(1)
    expect(result.reason).toContain('secret field')
    expect(result.pending.map(step => step.kind)).toEqual(['fill', 'click'])
    expect(calls.clicks).toEqual([3])
  })

  it('stops when the control is not on the page', async () => {
    const { driver } = fakeDriver()
    const result = await replayDemoSteps(driver, [click('不存在的按钮')])
    expect(result.status).toBe('blocked')
    if (result.status !== 'blocked') throw new Error('expected blocked')
    expect(result.reason).toContain('no control matching button "不存在的按钮"')
    expect(result.performed).toBe(0)
  })

  it('refuses selects and checkboxes instead of guessing', async () => {
    const { driver } = fakeDriver()
    const selectStep: DemoStep = {
      kind: 'fill', at: 1, role: 'combobox', name: '月份', selector: '#m', field: 'm', value: '11', masked: false,
    }
    const result = await replayDemoSteps(driver, [selectStep])
    expect(result.status).toBe('blocked')
    if (result.status !== 'blocked') throw new Error('expected blocked')
    expect(result.reason).toContain('select')
  })

  it('follows the tab a step belongs to and blocks when it is gone', async () => {
    const { driver, calls } = fakeDriver()
    const steps: DemoStep[] = [
      { ...click('导出报表'), tabId: 2 },
      { ...click('取消'), tabId: 3 },
    ]
    const done = await replayDemoSteps(driver, steps.slice(0, 1))
    expect(done.status).toBe('done')
    expect(calls.follows).toEqual([2])

    const missing = fakeDriver({ followFails: true })
    const blocked = await replayDemoSteps(missing.driver, steps)
    expect(blocked.status).toBe('blocked')
    if (blocked.status !== 'blocked') throw new Error('expected blocked')
    expect(blocked.reason).toContain('tab 2')
    expect(blocked.pending).toHaveLength(2)
  })
})
