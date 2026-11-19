import { describe, expect, it, vi } from 'vitest'
import type { DemoStep } from './demo.ts'
import {
  matchDemoControl,
  samePage,
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
  selects: Array<[number, string]>
  checks: Array<[number, boolean]>
  presses: string[]
  navigates: string[]
  follows: number[]
}

function fakeDriver(input: {
  readonly nodes?: readonly DemoReplayNode[]
  readonly url?: string
  readonly followFails?: boolean
  readonly tabs?: ReadonlyArray<{ readonly tabId: number; readonly url: string }>
  readonly snapshots?: ReadonlyArray<{ readonly url?: string; readonly nodes: readonly DemoReplayNode[] }>
  readonly resolveRef?: (selector: string) => number | null
} = {}): { driver: DemoReplayDriver; calls: Calls } {
  const calls: Calls = { clicks: [], types: [], selects: [], checks: [], presses: [], navigates: [], follows: [] }
  let url = input.url ?? 'https://example.com/'
  const queue = [...(input.snapshots ?? [])]
  const driver: DemoReplayDriver = {
    snapshot: vi.fn(async () => {
      const next = queue.shift()
      if (next?.url !== undefined) url = next.url
      return { url, nodes: next?.nodes ?? input.nodes ?? nodes }
    }),
    resolveRefBySelector: vi.fn(async (selector: string) => input.resolveRef?.(selector) ?? null),
    listTabs: vi.fn(async () => ({ tabs: input.tabs ?? [] })),
    click: vi.fn(async (ref: number) => {
      calls.clicks.push(ref)
      return { url }
    }),
    type: vi.fn(async (ref: number, text: string) => {
      calls.types.push([ref, text])
      return { url }
    }),
    select: vi.fn(async (ref: number, value: string) => {
      calls.selects.push([ref, value])
      return { url }
    }),
    check: vi.fn(async (ref: number, checked: boolean) => {
      calls.checks.push([ref, checked])
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

  it('uses the recorded selector to pick between same-named controls', async () => {
    const { driver, calls } = fakeDriver({
      nodes: [
        { ref: 5, role: 'button', name: '删除' },
        { ref: 6, role: 'button', name: '删除' },
      ],
      resolveRef: selector => (selector === '#row2 .del' ? 6 : null),
    })
    const result = await replayDemoSteps(driver, [
      { kind: 'click', at: 1, role: 'button', name: '删除', selector: '#row2 .del' },
    ])
    expect(result.status).toBe('done')
    expect(calls.clicks).toEqual([6])
  })

  it('refuses to guess when same-named controls cannot be told apart', async () => {
    const { driver, calls } = fakeDriver({
      nodes: [
        { ref: 5, role: 'button', name: '删除' },
        { ref: 6, role: 'button', name: '删除' },
      ],
    })
    const result = await replayDemoSteps(driver, [
      { kind: 'click', at: 1, role: 'button', name: '删除', selector: '#gone' },
    ])
    expect(result.status).toBe('blocked')
    expect(calls.clicks).toEqual([])
    if (result.status !== 'blocked') throw new Error('expected blocked')
    expect(result.reason).toContain('2 controls match')
  })

  it('waits for a control that renders late', async () => {
    const { driver, calls } = fakeDriver({
      nodes,
      snapshots: [{ nodes: [] }, { nodes }],
    })
    const result = await replayDemoSteps(driver, [click('导出报表')], { retryDelayMs: 0 })
    expect(result.status).toBe('done')
    expect(calls.clicks).toEqual([3])
  })

  it('stops when the control is not on the page', async () => {
    const { driver } = fakeDriver()
    const result = await replayDemoSteps(driver, [click('不存在的按钮')], { retryDelayMs: 0 })
    expect(result.status).toBe('blocked')
    if (result.status !== 'blocked') throw new Error('expected blocked')
    expect(result.reason).toContain('no control matching button "不存在的按钮"')
    expect(result.performed).toBe(0)
  })

  it('picks the recorded select option', async () => {
    const { driver, calls } = fakeDriver({
      nodes: [
        { ref: 5, role: 'combobox', name: '月份' },
        { ref: 6, role: 'checkbox', name: '记住我' },
      ],
    })
    const steps: DemoStep[] = [
      { kind: 'fill', at: 1, role: 'combobox', name: '月份', selector: '#m', field: 'm', value: '11', masked: false },
      { kind: 'fill', at: 2, role: 'checkbox', name: '记住我', selector: '#r', field: 'r', value: 'on', masked: false, checked: true },
    ]
    const result = await replayDemoSteps(driver, steps)
    expect(result.status).toBe('done')
    expect(calls.selects).toEqual([[5, '11']])
    expect(calls.checks).toEqual([[6, true]])
  })

  it('still stops at a masked secret', async () => {
    const { driver } = fakeDriver()
    const result = await replayDemoSteps(driver, [fill('密码', '***', 2, true)])
    expect(result.status).toBe('blocked')
    if (result.status !== 'blocked') throw new Error('expected blocked')
    expect(result.reason).toContain('secret field')
  })

  it('reopens the recorded start page when the current tab is elsewhere', async () => {
    const { driver, calls } = fakeDriver({ url: 'about:blank' })
    const steps: DemoStep[] = [
      { ...click('导出报表'), tabId: 1, tabUrl: 'https://example.com/admin' },
      { ...click('取消'), tabId: 1, tabUrl: 'https://example.com/admin' },
    ]
    const result = await replayDemoSteps(driver, steps)
    expect(result.status).toBe('done')
    expect(calls.navigates).toEqual(['https://example.com/admin'])
    expect(calls.clicks).toEqual([3, 4])
  })

  it('does not navigate when the flow already starts on that page', async () => {
    const { driver, calls } = fakeDriver({ url: 'https://example.com/admin?tab=1' })
    await replayDemoSteps(driver, [{ ...click('导出报表'), tabId: 1, tabUrl: 'https://example.com/admin' }])
    expect(calls.navigates).toEqual([])
  })

  it('leaves the first step alone when it is a navigate', async () => {
    const { driver, calls } = fakeDriver({ url: 'https://other.example/' })
    const steps: DemoStep[] = [
      { kind: 'navigate', at: 1, url: 'https://example.com/', tabId: 1, tabUrl: 'https://example.com/' },
      { ...click('导出报表'), tabId: 1, tabUrl: 'https://example.com/' },
    ]
    const result = await replayDemoSteps(driver, steps)
    expect(result.status).toBe('done')
    expect(calls.navigates).toEqual(['https://example.com/'])
  })

  it('does not touch tab ids for a single-tab flow (saved recipes outlive them)', async () => {
    const { driver, calls } = fakeDriver()
    const steps: DemoStep[] = [
      { ...click('导出报表'), tabId: 1, tabUrl: 'https://example.com/a' },
      { ...fill('日期', '2026-11-01'), tabId: 1, tabUrl: 'https://example.com/a' },
    ]
    const result = await replayDemoSteps(driver, steps)
    expect(result.status).toBe('done')
    expect(calls.follows).toEqual([])
  })

  it('re-maps a recorded tab to the live tab with the same page', async () => {
    const { driver, calls } = fakeDriver({
      tabs: [
        { tabId: 1, url: 'https://example.com/' },
        { tabId: 9, url: 'https://b.example/reports?range=1' },
      ],
    })
    const steps: DemoStep[] = [
      { ...click('导出报表'), tabId: 1, tabUrl: 'https://example.com/' },
      { ...click('取消'), tabId: 2, tabUrl: 'https://b.example/reports' },
    ]
    const result = await replayDemoSteps(driver, steps)
    expect(result.status).toBe('done')
    expect(calls.follows).toContain(9)
    expect(calls.follows).not.toContain(2)
    expect(calls.clicks).toEqual([3, 4])
  })

  it('reopens the recorded page when its tab is gone', async () => {
    const { driver, calls } = fakeDriver({ followFails: true, tabs: [] })
    const steps: DemoStep[] = [
      { ...click('导出报表'), tabId: 1, tabUrl: 'https://example.com/' },
      { ...click('取消'), tabId: 2, tabUrl: 'https://b.example/reports' },
    ]
    const result = await replayDemoSteps(driver, steps)
    expect(result.status).toBe('done')
    expect(calls.navigates).toContain('https://b.example/reports')
  })

  it('matches pages by origin and path, ignoring query and hash', () => {
    expect(samePage('https://a.example/x?q=1', 'https://a.example/x')).toBe(true)
    expect(samePage('https://a.example/x#top', 'https://a.example/x/')).toBe(true)
    expect(samePage('https://a.example/x', 'https://a.example/y')).toBe(false)
    expect(samePage('https://a.example/x', 'https://b.example/x')).toBe(false)
    expect(samePage('not a url', 'not a url')).toBe(true)
  })

  it('follows the tab a step belongs to and blocks when it is gone', async () => {
    const { driver, calls } = fakeDriver()
    const steps: DemoStep[] = [
      { ...click('导出报表'), tabId: 2 },
      { ...click('取消'), tabId: 3 },
    ]
    const done = await replayDemoSteps(driver, steps.slice(0, 1))
    expect(done.status).toBe('done')
    // One recorded tab: no id juggling at all (saved recipes outlive the ids).
    expect(calls.follows).toEqual([])

    const missing = fakeDriver({ followFails: true })
    const blocked = await replayDemoSteps(missing.driver, steps)
    expect(blocked.status).toBe('blocked')
    if (blocked.status !== 'blocked') throw new Error('expected blocked')
    expect(blocked.reason).toContain('tab 2')
    expect(blocked.pending).toHaveLength(2)
  })
})
