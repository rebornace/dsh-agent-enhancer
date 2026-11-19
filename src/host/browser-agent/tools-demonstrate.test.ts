import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserDriver } from './driver.ts'
import type { DemoStep } from './demo.ts'
import { BrowserHumanGate } from './human-gate.ts'
import { BrowserSessionState } from './session-state.ts'
import { registerBrowserTools } from './tools.ts'

interface RegisteredTool {
  readonly name: string
  execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>
}

const steps: DemoStep[] = [
  { kind: 'navigate', at: 1, url: 'https://example.com/login' },
  { kind: 'fill', at: 2, role: 'textbox', name: 'Email', selector: '#email', field: 'email', value: 'me@example.com', masked: false },
  { kind: 'fill', at: 3, role: 'textbox', name: 'Password', selector: '#pw', field: 'password', value: '***', masked: true },
  { kind: 'click', at: 4, role: 'button', name: 'Sign in', selector: '#signin' },
]

function harness(demonstrate: boolean, recorded: readonly DemoStep[] = steps) {
  const tools = new Map<string, RegisteredTool>()
  const calls = { clicks: [] as number[], types: [] as Array<[number, string]>, presses: [] as string[] }
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
    pageStatus: async () => ({ connected: true, url: 'https://example.com/login', title: 'Login', tabId: 1, bound: true }),
    bind: async (tabId: number) => ({ tabId, url: 'https://example.com/login', title: 'Login' }),
    followTab: async (tabId: number) => ({ tabId, url: 'https://example.com/login', title: 'Login' }),
    navigate: async (url: string) => ({ url, title: 'Login', tabId: 1 }),
    snapshot: async () => ({
      url: 'https://example.com/login',
      title: 'Login',
      nodes: [
        { ref: 1, role: 'textbox', name: 'Email' },
        { ref: 2, role: 'button', name: 'Sign in' },
      ],
      refs: [],
      text: '',
    }),
    click: async (ref: number) => {
      calls.clicks.push(ref)
      return { url: 'https://example.com/login', title: 'Login', tabId: 1 }
    },
    type: async (ref: number, text: string) => {
      calls.types.push([ref, text])
      return { url: 'https://example.com/login', title: 'Login', tabId: 1 }
    },
    press: async (key: string) => {
      calls.presses.push(key)
      return { url: 'https://example.com/login', title: 'Login', tabId: 1 }
    },
    startDemonstration: vi.fn(async () => undefined),
    stopDemonstration: vi.fn(async () => recorded),
  } as unknown as BrowserDriver

  const gate = new BrowserHumanGate()
  gate.setListener(request => {
    if (request !== null) gate.acknowledge(request.sessionId)
  })

  const sessions = new BrowserSessionState()
  registerBrowserTools(ctx, {
    driver,
    approval: { requestApproval: async () => 'allow', current: () => null } as never,
    human: gate,
    sessions,
    demonstrate: () => demonstrate,
    enabled: () => true,
  })

  const exec = { agent: { session: { id: 's1' } }, signal: new AbortController().signal }
  return {
    driver,
    calls,
    run: (args: Record<string, unknown>) => {
      const tool = tools.get('browser_demonstrate')
      if (tool === undefined) throw new Error('browser_demonstrate not registered')
      return tool.execute(args, exec)
    },
  }
}

describe('browser_demonstrate', () => {
  it('refuses when the recording switch is off and records nothing', async () => {
    const h = harness(false)
    await expect(h.run({ message: 'show me' })).rejects.toThrow(/演示录制/)
    expect(h.driver.startDemonstration).not.toHaveBeenCalled()
  })

  it('records, then returns replayable steps with secrets masked', async () => {
    const h = harness(true)
    const out = await h.run({ message: 'show me how you sign in' }) as string
    expect(h.driver.startDemonstration).toHaveBeenCalled()
    expect(h.driver.stopDemonstration).toHaveBeenCalled()
    expect(out).toContain('demonstrated steps: 4')
    expect(out).toContain('masked fields: 1')
    expect(out).toContain('navigate -> https://example.com/login')
    expect(out).toContain('"me@example.com"')
    expect(out).toContain('= ***')
    expect(out).toContain('click button "Sign in"')
    expect(out).toContain('browser_snapshot')
  })

  it('requires a message', async () => {
    const h = harness(true)
    // The tool schema rejects the missing argument before the handler runs.
    await expect(h.run({})).rejects.toThrow(/message/)
    expect(h.driver.startDemonstration).not.toHaveBeenCalled()
  })

  it('tags steps per tab and points at browser_follow_tab when the flow crosses tabs', async () => {
    const acrossTabs: DemoStep[] = [
      { kind: 'navigate', at: 1, url: 'https://example.com/admin', tabId: 1, tabUrl: 'https://example.com/admin' },
      { kind: 'click', at: 2, role: 'link', name: 'Reports', selector: '#reports', tabId: 1, tabUrl: 'https://example.com/admin' },
      { kind: 'navigate', at: 3, url: 'https://example.com/reports', tabId: 2, tabUrl: 'https://example.com/reports' },
      { kind: 'click', at: 4, role: 'button', name: 'Export', selector: '#export', tabId: 2, tabUrl: 'https://example.com/reports' },
    ]
    const h = harness(true, acrossTabs)
    const out = await h.run({ message: 'show me the export flow' }) as string
    expect(out).toContain('tabs: 2')
    expect(out).toContain('tab 1: https://example.com/admin')
    expect(out).toContain('tab 2: https://example.com/reports')
    expect(out).toContain('2. [tab 1] click link "Reports"')
    expect(out).toContain('4. [tab 2] click button "Export"')
    expect(out).toContain('browser_follow_tab')
  })

  it('keeps the single-tab output free of tab tags', async () => {
    const h = harness(true)
    const out = await h.run({ message: 'show me how you sign in' }) as string
    expect(out).not.toContain('[tab ')
    expect(out).not.toContain('browser_follow_tab')
  })

  it('replays the recorded flow when asked and reports each step', async () => {
    const clean: DemoStep[] = [steps[0]!, steps[1]!, steps[3]!]
    const h = harness(true, clean)
    const out = await h.run({ message: 'show me how you sign in', replay: true }) as string
    expect(out).toContain('replayed 3/3')
    expect(out).toContain('1. ok   navigate -> https://example.com/login')
    expect(out).toContain('2. ok   fill textbox "Email" = "me@example.com"')
    expect(out).toContain('3. ok   click button "Sign in"')
    expect(h.calls.types).toEqual([[1, 'me@example.com']])
    expect(h.calls.clicks).toEqual([2])
  })

  it('stops the replay at a masked secret instead of pretending', async () => {
    const h = harness(true)
    const out = await h.run({ message: 'show me how you sign in', replay: true }) as string
    // Steps 1-2 are the navigation and the email; the password stops it.
    expect(out).toContain('replayed 2/4')
    expect(out).toContain('stopped at step 3')
    expect(out).toContain('secret field "Password" was masked')
    expect(out).toContain('3. todo fill textbox "Password" = ***')
    expect(out).toContain('Do not claim the flow finished')
  })
})
