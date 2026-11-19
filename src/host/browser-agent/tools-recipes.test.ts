import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserDriver } from './driver.ts'
import type { DemoStep } from './demo.ts'
import { DemoRecipeStore } from './demo-recipes.ts'
import { BrowserHumanGate } from './human-gate.ts'
import { BrowserSessionState } from './session-state.ts'
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
  readonly recipes?: readonly { name: string; steps: readonly DemoStep[] }[]
  readonly demonstrate?: boolean
} = {}) {
  const tools = new Map<string, RegisteredTool>()
  const approvals: string[] = []
  const clicks: number[] = []
  const store = new DemoRecipeStore(null)
  for (const recipe of input.recipes ?? []) store.save({ name: recipe.name, steps: recipe.steps })

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
      nodes: [
        { ref: 3, role: 'button', name: '导出报表' },
        { ref: 4, role: 'button', name: '取消' },
      ],
      refs: [],
      text: '',
    }),
    click: async (ref: number) => {
      clicks.push(ref)
      return { url: 'https://example.com/admin', title: 'Admin', tabId: 1 }
    },
    type: async () => ({ url: 'https://example.com/admin', title: 'Admin', tabId: 1 }),
    select: async () => ({ url: 'https://example.com/admin', title: 'Admin', tabId: 1 }),
    check: async () => ({ url: 'https://example.com/admin', title: 'Admin', tabId: 1 }),
    press: async () => ({ url: 'https://example.com/admin', title: 'Admin', tabId: 1 }),
  } as unknown as BrowserDriver

  registerBrowserTools(ctx, {
    driver,
    approval: {
      requestApproval: async (request: { summary: string }) => {
        approvals.push(request.summary)
        return 'allow'
      },
      current: () => null,
    } as never,
    human: new BrowserHumanGate(),
    sessions: new BrowserSessionState(),
    demonstrate: () => input.demonstrate !== false,
    recipes: store,
    enabled: () => true,
  })

  const exec = { agent: { session: { id: 's1' } }, signal: new AbortController().signal }
  return {
    approvals,
    clicks,
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
    expect(out).toContain('- 周报导出 (2 step(s))')
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
})
