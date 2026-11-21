import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserDriver } from './driver.ts'
import type { DemoStep } from './demo.ts'
import { DemoRecipeStore } from './demo-recipes.ts'
import { DemoRepairTracker, createRepairHooks } from './demo-heal.ts'
import { BrowserHumanGate } from './human-gate.ts'
import { BrowserSessionState } from './session-state.ts'
import { TabScopeStore } from './tab-scope.ts'
import { registerBrowserTools } from './tools.ts'

interface RegisteredTool {
  readonly name: string
  execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>
}

const steps: DemoStep[] = [
  { kind: 'click', at: 1, role: 'button', name: '导出报表', selector: '#export', tabUrl: 'https://example.com/admin' },
  { kind: 'click', at: 2, role: 'button', name: '取消', selector: '#cancel', tabUrl: 'https://example.com/admin' },
]

function harness(input: {
  readonly recipes?: readonly { name: string; steps: readonly DemoStep[]; unattended?: boolean }[]
  readonly demonstrate?: boolean
  readonly variables?: readonly { readonly index: number; readonly name: string }[]
  /** Snapshot the page shows (default: the recorded controls). */
  readonly nodes?: ReadonlyArray<{ readonly ref: number; readonly role: string; readonly name: string }>
  /** Where a click lands; a different URL keeps browser_click from seeing a no-op. */
  readonly clickThen?: string
  /** Permission preset the harness reports for the session. */
  readonly permission?: 'full' | 'ask' | 'read-only'
  /** Extra evidence for refs the "agent" clicks during a repair. */
  readonly refInfo?: Readonly<Record<number, { readonly role: string; readonly name: string; readonly selector: string }>>
  /** Mark the bound tab (id 1) read-only, as the sidebar toggle would. */
  readonly readOnly?: boolean
  /** Configured unattended budget; omitted means the 20 min / 30 action default. */
  readonly unattended?: { readonly minutes: number; readonly actions: number }
} = {}) {
  const tools = new Map<string, RegisteredTool>()
  const approvals: string[] = []
  const granted: string[] = []
  const grantCalls: Array<{ url: string; ttlMs: number; actions: number }> = []
  const revoked: string[] = []
  const originOf = (url: string | undefined): string | undefined => {
    if (url === undefined) return undefined
    try {
      return new URL(url).origin
    } catch {
      return undefined
    }
  }
  const clicks: number[] = []
  const types: string[] = []
  const store = new DemoRecipeStore(null)
  const repair = createRepairHooks({ tracker: new DemoRepairTracker(), store })
  const sessions = new BrowserSessionState()
  const tabScope = new TabScopeStore()
  if (input.readOnly === true) {
    sessions.bind('s1', 1)
    tabScope.setReadOnly(1, true)
  }
  let firstId: string | undefined
  for (const recipe of input.recipes ?? []) {
    const saved = store.save({ name: recipe.name, steps: recipe.steps })
    if (saved.ok && firstId === undefined) firstId = saved.recipe.id
    if (saved.ok && recipe.unattended === true) store.setUnattended({ id: saved.recipe.id, unattended: true })
  }
  for (const variable of input.variables ?? []) {
    if (firstId === undefined) throw new Error('no recipe to parameterize')
    const result = store.parameterize({ id: firstId, index: variable.index, name: variable.name })
    if (!result.ok) throw new Error(result.error)
  }

  const ctx = {
    tools: {
      register(tool: RegisteredTool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
  } as unknown as Context

  const driver = {
    kind: 'playwright',
    status: () => ({ kind: 'playwright', ready: true, listening: true }),
    ensureReady: async () => undefined,
    pageStatus: async () => ({ connected: true, url: 'https://example.com/admin', title: 'Admin', tabId: 1, bound: true }),
    bind: async (tabId: number) => ({ tabId, url: 'https://example.com/admin', title: 'Admin' }),
    followTab: async (tabId: number) => ({ tabId, url: 'https://example.com/admin', title: 'Admin' }),
    navigate: async (url: string) => ({ url, title: 'Admin', tabId: 1 }),
    snapshot: async () => ({
      url: 'https://example.com/admin',
      title: 'Admin',
      nodes: input.nodes ?? [
        { ref: 3, role: 'button', name: '导出报表' },
        { ref: 4, role: 'button', name: '取消' },
        { ref: 5, role: 'textbox', name: '关键词' },
      ],
      refs: [],
      text: '',
      textPreview: '',
    }),
    click: async (ref: number) => {
      clicks.push(ref)
      return { url: input.clickThen ?? 'https://example.com/admin', title: 'Admin', tabId: 1 }
    },
    refInfo: async (ref: number) => input.refInfo?.[ref] ?? null,
    type: async (_ref: number, text: string) => {
      types.push(text)
      return { url: 'https://example.com/admin', title: 'Admin', tabId: 1 }
    },
    select: async () => ({ url: 'https://example.com/admin', title: 'Admin', tabId: 1 }),
    check: async () => ({ url: 'https://example.com/admin', title: 'Admin', tabId: 1 }),
    press: async () => ({ url: 'https://example.com/admin', title: 'Admin', tabId: 1 }),
  } as unknown as BrowserDriver

  registerBrowserTools(ctx, {
    driver,
    approval: {
      grantOrigin: (input: { url: string; ttlMs: number; actions: number }) => {
        granted.push(input.url)
        grantCalls.push({ url: input.url, ttlMs: input.ttlMs, actions: input.actions })
        return true
      },
      revokeOrigin: (input: { url: string }) => {
        revoked.push(input.url)
        return true
      },
      isPreauthorized: (_sessionId: string, url: string | undefined) => originOf(url) !== undefined
        && granted.includes(originOf(url)!),
      requestApproval: async (request: { summary: string; url?: string }) => {
        // Mirrors the real gate: a preauthorized origin never reaches the card.
        const origin = originOf(request.url)
        if (origin !== undefined && granted.includes(origin)) return 'allow'
        approvals.push(request.summary)
        return 'allow'
      },
      current: () => null,
    } as never,
    human: new BrowserHumanGate(),
    sessions,
    tabScope,
    ...(input.permission === undefined ? {} : { permission: () => input.permission }),
    ...(input.unattended === undefined ? {} : { unattended: () => input.unattended! }),
    demonstrate: () => input.demonstrate !== false,
    recipes: store,
    repair,
    enabled: () => true,
  })

  const exec = { agent: { session: { id: 's1' } }, signal: new AbortController().signal }
  return {
    approvals,
    granted,
    grantCalls,
    revoked,
    clicks,
    types,
    store,
    tool: (name: string) => {
      const found = tools.get(name)
      if (found === undefined) throw new Error(`${name} not registered`)
      return (args: Record<string, unknown>) => found.execute(args, exec)
    },
    run: (args: Record<string, unknown>) => {
      const tool = tools.get('browser_demo_recipes')
      if (tool === undefined) throw new Error('browser_demo_recipes not registered')
      return tool.execute(args, exec)
    },
  }
}

describe('browser_demo_recipes', () => {
  it('lists saved flows', async () => {
    const h = harness({ recipes: [{ name: '周报导出', steps }] })
    const out = await h.run({ action: 'list' }) as string
    expect(out).toContain('saved flows: 1')
    expect(out).toContain('- 周报导出 (2 step(s)')
  })

  it('shows the recorded site and rejects a mismatch', async () => {
    const h = harness({ recipes: [{ name: '周报导出', steps }] })
    const listed = await h.run({ action: 'list' }) as string
    expect(listed).toContain('site: https://example.com')

    await expect(h.run({ action: 'run', name: '周报导出', site: 'https://elsewhere.example' }))
      .rejects.toThrow(/does not match flow/)
    const ran = await h.run({ action: 'run', name: '周报导出', site: 'https://example.com' }) as string
    expect(ran).toContain('replayed 2/2')
  })

  it('records how the last run ended', async () => {
    const h = harness({ recipes: [{ name: '周报导出', steps }] })
    await h.run({ action: 'run', name: '周报导出' })
    expect(h.store.list()[0]?.lastRun).toMatchObject({ status: 'ok', performed: 2, total: 2 })

    // A different page makes step 1 fail: the flow records a stopped run.
    const blocked = harness({
      recipes: [{ name: '周报导出', steps }],
      nodes: [{ ref: 4, role: 'button', name: '取消' }],
    })
    await blocked.run({ action: 'run', name: '周报导出' })
    expect(blocked.store.list()[0]?.lastRun).toMatchObject({ status: 'stopped', performed: 0, total: 2 })
  })

  it('says so when nothing is saved', async () => {
    const h = harness()
    const out = await h.run({ action: 'list' }) as string
    expect(out).toContain('saved flows: 0')
  })

  it('runs a flow by a unique part of its name, after one approval', async () => {
    const h = harness({ recipes: [{ name: '周报导出', steps }] })
    const out = await h.run({ action: 'run', name: '周报' }) as string
    expect(h.approvals).toHaveLength(1)
    expect(h.approvals[0]).toContain('周报导出')
    expect(h.clicks).toEqual([3, 4])
    expect(out).toContain('replayed 2/2')
    expect(out).toContain('1. ok   click button "导出报表"')
  })

  it('refuses to replay into a tab the user marked read-only', async () => {
    const h = harness({ recipes: [{ name: '周报导出', steps }], readOnly: true })
    await expect(h.run({ action: 'run', name: '周报导出' })).rejects.toThrow(/tab_read_only/)
    // Refused before any approval or page op: nothing clicked, nothing granted.
    expect(h.approvals).toEqual([])
    expect(h.granted).toEqual([])
    expect(h.clicks).toEqual([])
  })

  it('reports an unknown flow instead of guessing', async () => {
    const h = harness({ recipes: [{ name: '周报导出', steps }] })
    await expect(h.run({ action: 'run', name: '月报' })).rejects.toThrow(/No unique saved flow/)
    expect(h.approvals).toEqual([])
  })

  it('stops at a masked secret and lists what is left', async () => {
    const secret: DemoStep[] = [
      { kind: 'click', at: 1, role: 'button', name: '导出报表', selector: '#export' },
      { kind: 'fill', at: 2, role: 'textbox', name: 'Password', selector: '#pw', field: 'password', value: '***', masked: true },
      { kind: 'click', at: 3, role: 'button', name: '取消', selector: '#cancel' },
    ]
    const h = harness({ recipes: [{ name: '登录', steps: secret }] })
    const out = await h.run({ action: 'run', name: '登录' }) as string
    expect(out).toContain('replayed 1/3')
    expect(out).toContain('stopped at step 2')
    expect(out).toContain('secret field "Password" was masked')
    expect(out).toContain('2. todo')
    expect(out).toContain('Do not claim the flow finished')
  })

  it('is gated by the demonstration switch', async () => {
    const h = harness({ recipes: [{ name: '周报导出', steps }], demonstrate: false })
    await expect(h.run({ action: 'list' })).rejects.toThrow(/演示录制/)
  })

  it('fills variables defaulting to the saved value', async () => {
    const withFill: DemoStep[] = [
      { kind: 'fill', at: 1, role: 'textbox', name: '关键词', selector: '#q', field: 'q', value: '旧值', masked: false },
      { kind: 'click', at: 2, role: 'button', name: '导出报表', selector: '#export' },
    ]
    const h = harness({
      recipes: [{ name: '搜索导出', steps: withFill }],
      variables: [{ index: 0, name: 'term' }],
    })
    const out = await h.run({ action: 'run', name: '搜索导出' }) as string
    expect(out).toContain('replayed 2/2')
    expect(h.types).toEqual(['旧值'])
  })

  it('takes supplied variables and refuses an explicitly empty one', async () => {
    const withFill: DemoStep[] = [
      { kind: 'fill', at: 1, role: 'textbox', name: '关键词', selector: '#q', field: 'q', value: '旧值', masked: false },
      { kind: 'click', at: 2, role: 'button', name: '导出报表', selector: '#export' },
    ]
    const h = harness({
      recipes: [{ name: '搜索导出', steps: withFill }],
      variables: [{ index: 0, name: 'term' }],
    })
    await expect(h.run({ action: 'run', name: '搜索导出', vars: { term: '' } }))
      .rejects.toThrow(/still needs 关键词/)
    const supplied = await h.run({ action: 'run', name: '搜索导出', vars: { term: '新值' } }) as string
    expect(supplied).toContain('replayed 2/2')
    expect(h.types).toContain('新值')
  })
})

describe('browser_demo_recipes values', () => {
  const dated: DemoStep[] = [
    { kind: 'fill', at: 1, role: 'textbox', name: '开始日期', selector: '#from', field: 'from', value: '2026-11-01', masked: false },
    { kind: 'click', at: 2, role: 'button', name: '导出报表', selector: '#export' },
  ]

  it('asks for a missing value by its label, in words', async () => {
    const h = harness({ recipes: [{ name: '周报', steps: dated }], variables: [{ index: 0, name: 'from' }] })
    await expect(h.run({ action: 'run', name: '周报', vars: { 开始日期: '' } }))
      .rejects.toThrow(/still needs 开始日期\. Ask the user/)
  })

  it('accepts a value under its label and resolves a relative date', async () => {
    const h = harness({
      recipes: [{ name: '周报', steps: dated }],
      variables: [{ index: 0, name: 'from' }],
      nodes: [
        { ref: 5, role: 'textbox', name: '开始日期' },
        { ref: 6, role: 'button', name: '导出报表' },
      ],
    })
    const out = await h.run({ action: 'run', name: '周报', vars: { 开始日期: '上周' } }) as string
    expect(out).toContain('resolved: 开始日期 上周 →')
    expect(h.types).toHaveLength(1)
    expect(h.types[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('leaves a non-date value alone', async () => {
    const search: DemoStep[] = [
      { kind: 'fill', at: 1, role: 'textbox', name: '关键词', selector: '#q', field: 'q', value: '旧值', masked: false },
      { kind: 'click', at: 2, role: 'button', name: '导出报表', selector: '#export' },
    ]
    const h = harness({ recipes: [{ name: '搜索', steps: search }], variables: [{ index: 0, name: 'term' }] })
    await h.run({ action: 'run', name: '搜索', vars: { 关键词: '上周' } })
    expect(h.types).toEqual(['上周'])
  })
})

describe('browser_demo_recipes ask mode', () => {
  const dated: DemoStep[] = [
    { kind: 'fill', at: 1, role: 'textbox', name: '开始日期', selector: '#from', field: 'from', value: '2026-11-01', masked: false },
  ]

  it('asks for an ask-variable even though a default exists', async () => {
    const h = harness({
      recipes: [{ name: '周报', steps: dated }],
      variables: [{ index: 0, name: 'from' }],
      nodes: [{ ref: 5, role: 'textbox', name: '开始日期' }],
    })
    const id = h.store.list()[0]!.id
    h.store.updateVariable({ id, name: 'from', label: '开始日期', ask: true })
    await expect(h.run({ action: 'run', name: '周报' })).rejects.toThrow(/still needs 开始日期/)
    await expect(h.run({ action: 'run', name: '周报', vars: { 开始日期: '' } })).rejects.toThrow(/still needs 开始日期/)
    const out = await h.run({ action: 'run', name: '周报', vars: { 开始日期: '2026-10-01' } }) as string
    expect(out).toContain('replayed 1/1')
    expect(h.types).toEqual(['2026-10-01'])
  })
})

describe('unattended flows', () => {
  const steps: DemoStep[] = [
    { kind: 'click', at: 1, role: 'button', name: '导出报表', selector: '#export', tabUrl: 'https://example.com/admin' },
  ]

  it('runs a marked flow without a card and grants its site', async () => {
    const h = harness({ recipes: [{ name: '周报', steps, unattended: true }] })
    const out = await h.run({ action: 'run', name: '周报', site: 'https://example.com' }) as string
    expect(out).toContain('replayed 1/1')
    expect(out).toContain('unattended: https://example.com is authorized')
    expect(h.approvals).toEqual([])
    expect(h.granted).toEqual(['https://example.com'])
  })

  it('grants the configured budget instead of the 20 / 30 default', async () => {
    const h = harness({
      recipes: [{ name: '周报', steps, unattended: true }],
      unattended: { minutes: 45, actions: 120 },
    })
    const out = await h.run({ action: 'run', name: '周报', site: 'https://example.com' }) as string
    expect(h.grantCalls).toEqual([
      { url: 'https://example.com', ttlMs: 45 * 60_000, actions: 120 },
    ])
    expect(out).toContain('45 min / 120 actions')
  })

  it('revokes the grant when the run is refused', async () => {
    const probe = harness({ recipes: [{ name: '周报', steps, unattended: true }] })
    console.log('PROBE', JSON.stringify(probe.store.list()))

    const h = harness({ recipes: [{ name: '周报', steps, unattended: true }], permission: 'read-only' })
    await expect(h.run({ action: 'run', name: '周报', site: 'https://example.com' })).rejects.toThrow(/仅可查看/)
    expect(h.granted).toEqual(['https://example.com'])
    expect(h.revoked).toEqual(['https://example.com'])
    // Nothing ran, so nothing was recorded either.
    expect(h.store.list()[0]?.lastRun).toBeUndefined()
  })

  it('still asks for a flow that was not marked', async () => {
    const h = harness({ recipes: [{ name: '周报', steps }] })
    await h.run({ action: 'run', name: '周报', site: 'https://example.com' })
    expect(h.approvals).toHaveLength(1)
    expect(h.granted).toEqual([])
  })

  it('lists the flag so the agent can see it', async () => {
    const h = harness({ recipes: [{ name: '周报', steps, unattended: true }] })
    const listed = await h.run({ action: 'list' }) as string
    expect(listed).toContain('unattended: yes')
  })
})

describe('browser_demo_recipes repair', () => {
  const moved: DemoStep[] = [
    { kind: 'click', at: 1, role: 'button', name: '导出报表', selector: '#export', tabUrl: 'https://example.com/admin' },
  ]

  it('turns the agent\'s workaround into a repair the user can accept', async () => {
    const h = harness({
      recipes: [{ name: '周报导出', steps: moved }],
      nodes: [
        { ref: 7, role: 'button', name: '下载明细' },
        { ref: 4, role: 'button', name: '取消' },
      ],
      clickThen: 'https://example.com/export-report',
      refInfo: { 7: { role: 'button', name: '下载明细', selector: '#export-new' } },
    })
    const blocked = await h.run({ action: 'run', name: '周报导出' }) as string
    expect(blocked).toContain('stopped at step 1')
    expect(blocked).toContain('action: "heal"')

    // The agent looks at the page, finds the control, and clicks it.
    await h.tool('browser_snapshot')({})
    await h.tool('browser_click')({ ref: 7, label: '下载明细' })

    const offered = await h.run({ action: 'heal' }) as string
    expect(offered).toContain('repair offered')
    expect(h.store.list()[0]?.pendingHeal).toMatchObject({ failedAt: 1 })
    expect(h.store.list()[0]?.pendingHeal?.replacement).toMatchObject({ name: '下载明细' })

    const id = h.store.list()[0]!.id
    const applied = await h.run({ action: 'heal', id, accept: true }) as string
    expect(applied).toContain('repair applied')
    expect(h.store.list()[0]?.pendingHeal).toBeUndefined()
    expect(h.store.get(id)?.steps[0]).toMatchObject({ name: '下载明细', selector: '#export-new' })
    expect(h.store.list()[0]?.rev).toBe(2)
  })

  it('offers nothing after a masked secret', async () => {
    const secret: DemoStep[] = [
      { kind: 'fill', at: 1, role: 'textbox', name: 'Password', selector: '#pw', field: 'password', value: '***', masked: true },
    ]
    const h = harness({ recipes: [{ name: '登录', steps: secret }] })
    await h.run({ action: 'run', name: '登录' })
    const out = await h.run({ action: 'heal' }) as string
    expect(out).toContain('nothing to remember')
    expect(h.store.list()[0]?.pendingHeal).toBeUndefined()
  })
})
