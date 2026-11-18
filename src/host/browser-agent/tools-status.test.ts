import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserDriver } from './driver.ts'
import { BrowserSessionState } from './session-state.ts'
import { registerBrowserTools } from './tools.ts'
import type { Diagnosis } from './diagnose.ts'

interface RegisteredTool {
  readonly name: string
  execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>
}

function harness(diagnosis: Diagnosis, ready: boolean) {
  const tools = new Map<string, RegisteredTool>()
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
    status: () => ({
      kind: 'playwright',
      ready,
      listening: ready,
      lastError: ready ? null : diagnosis.detail ?? 'not started',
      endpoint: 'playwright:chrome',
    }),
    ensureReady: async () => undefined,
    pageStatus: async () => ({ connected: true, url: 'https://example.com/', title: 'Example', tabId: 1, bound: true }),
    listTabs: async () => ({ tabs: [], boundTabId: null }),
    bind: async (tabId: number) => ({ tabId, url: 'https://example.com/', title: 'Example' }),
    followTab: async (tabId: number) => ({ tabId, url: 'https://example.com/', title: 'Example' }),
  } as unknown as BrowserDriver

  const sessions = new BrowserSessionState()
  registerBrowserTools(ctx, {
    driver,
    approval: { requestApproval: async () => 'allow', current: () => null } as never,
    human: { current: () => null } as never,
    sessions,
    diagnosis: () => diagnosis,
    enabled: () => true,
  })

  const exec = { agent: { session: { id: 's1' } }, signal: new AbortController().signal }
  const run = (name: string) => {
    const tool = tools.get(name)
    if (tool === undefined) throw new Error(`tool ${name} not registered`)
    return tool.execute({}, exec)
  }
  return { run }
}

const idle: Diagnosis = {
  code: 'idle',
  nextStep: 'Nothing launched yet. Call browser_navigate.',
  browsers: { chrome: true, edge: false, safari: false },
}

describe('browser_status diagnosis', () => {
  it('names the diagnosis and next step while the browser is not ready', async () => {
    const out = await harness(idle, false).run('browser_status') as string
    expect(out).toContain('diagnosis: idle')
    expect(out).toContain('next: Nothing launched yet')
    expect(out).not.toContain('extension:')
    expect(out).not.toContain('bridge:')
  })

  it('keeps the diagnosis when the browser is ready', async () => {
    const out = await harness({
      code: 'ok',
      nextStep: 'Ready: page tools act on the bound tab listed above.',
      browsers: { chrome: true, edge: true, safari: false },
    }, true).run('browser_status') as string
    expect(out).toContain('browser: ready')
    expect(out).toContain('diagnosis: ok')
    expect(out).toContain('url: https://example.com/')
  })

  it('surfaces the failure detail for a launch problem', async () => {
    const out = await harness({
      code: 'profile_locked',
      nextStep: 'The dedicated profile is still held by another process.',
      detail: 'ProcessSingleton: failed',
      browsers: { chrome: true, edge: true, safari: false },
    }, false).run('browser_status') as string
    expect(out).toContain('diagnosis: profile_locked')
    expect(out).toContain('detail: ProcessSingleton: failed')
  })
})
