import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserDriver } from './driver.ts'
import { BrowserHumanGate } from './human-gate.ts'
import { BrowserSessionState } from './session-state.ts'
import { registerBrowserTools } from './tools.ts'

interface RegisteredTool {
  readonly name: string
  execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>
}

function harness(gate: BrowserHumanGate) {
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
    status: () => ({ kind: 'playwright', ready: true, listening: true }),
    ensureReady: async () => undefined,
    pageStatus: async () => ({ connected: true, url: 'https://example.com/', title: 'Example', tabId: 1, bound: true }),
    bind: async (tabId: number) => ({ tabId, url: 'https://example.com/', title: 'Example' }),
    followTab: async (tabId: number) => ({ tabId, url: 'https://example.com/', title: 'Example' }),
    snapshot: async () => ({
      url: 'https://example.com/',
      title: 'Example',
      tabId: 1,
      textPreview: '',
      nodes: [],
    }),
  } as unknown as BrowserDriver

  const sessions = new BrowserSessionState()
  registerBrowserTools(ctx, {
    driver,
    approval: { requestApproval: async () => 'allow', current: () => null } as never,
    human: gate,
    sessions,
    enabled: () => true,
  })

  const exec = { agent: { session: { id: 's1' } }, signal: new AbortController().signal }
  return {
    sessions,
    run: (name: string, args: Record<string, unknown>) => {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`tool ${name} not registered`)
      return tool.execute(args, exec)
    },
  }
}

describe('browser_ask_user card kind', () => {
  it('marks a generic browser request as ask, not a login wall', async () => {
    const gate = new BrowserHumanGate()
    const h = harness(gate)
    const onRequest = vi.fn()
    gate.setListener(request => {
      onRequest(request)
      if (request !== null) gate.acknowledge(request.sessionId)
    })

    await expect(h.run('browser_ask_user', { prompt: '请手动关掉 B 标签' })).resolves.toBeTruthy()
    const request = onRequest.mock.calls[0]?.[0]
    expect(request?.kind).toBe('ask')
    expect(request?.detail).toContain('请手动关掉 B 标签')
  })
})
