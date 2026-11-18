import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserDriver } from './driver.ts'
import type { CaptureEntry } from './capture.ts'
import { BrowserSessionState } from './session-state.ts'
import { registerBrowserTools } from './tools.ts'

interface RegisteredTool {
  readonly name: string
  execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>
}

const networkEntry: CaptureEntry = {
  kind: 'request',
  at: 1,
  tabId: 2,
  method: 'GET',
  url: 'https://example.com/api?token=***',
  resourceType: 'fetch',
  status: 200,
  durationMs: 12,
}

const consoleEntry: CaptureEntry = {
  kind: 'console',
  at: 2,
  tabId: 2,
  level: 'error',
  text: 'boom',
  location: 'https://example.com/app.js:10',
}

function harness(debugTools: () => boolean) {
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
    bind: async (tabId: number) => ({ tabId, url: 'https://example.com/', title: 'Example' }),
    followTab: async (tabId: number) => ({ tabId, url: 'https://example.com/', title: 'Example' }),
    pageStatus: async () => ({ connected: true, url: 'https://example.com/', title: 'Example', tabId: 2, bound: true }),
    startCapture: vi.fn(),
    stopCapture: vi.fn(),
    readCapture: vi.fn((input: { kind: string }) => ({
      entries: input.kind === 'console' ? [consoleEntry] : [networkEntry],
      dropped: 0,
    })),
    emulate: vi.fn(async () => ({
      url: 'https://example.com/',
      title: 'Example',
      applied: ['colorScheme=dark'],
      tabId: 2,
    })),
  } as unknown as BrowserDriver

  const sessions = new BrowserSessionState()
  sessions.bind('s1', 2)

  registerBrowserTools(ctx, {
    driver,
    approval: { requestApproval: async () => 'allow', current: () => null } as never,
    human: { current: () => null } as never,
    sessions,
    debugTools,
    enabled: () => true,
  })

  const exec = { agent: { session: { id: 's1' } }, signal: new AbortController().signal }
  const run = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.get(name)
    if (tool === undefined) throw new Error(`tool ${name} not registered`)
    return tool.execute(args, exec)
  }
  return { run, driver }
}

describe('debug tools switch', () => {
  it('refuses all three tools when the switch is off', async () => {
    const h = harness(() => false)
    await expect(h.run('browser_network')).rejects.toThrow(/debug tools are off/)
    await expect(h.run('browser_console')).rejects.toThrow(/debug tools are off/)
    await expect(h.run('browser_emulate', { colorScheme: 'dark' })).rejects.toThrow(/debug tools are off/)
    expect(h.driver.startCapture).not.toHaveBeenCalled()
    expect(h.driver.stopCapture).toHaveBeenCalled()
    expect(h.driver.emulate).not.toHaveBeenCalled()
  })

  it('starts capture and prints network rows when enabled', async () => {
    const h = harness(() => true)
    const out = await h.run('browser_network', { limit: 5 }) as string
    expect(h.driver.startCapture).toHaveBeenCalled()
    expect(h.driver.stopCapture).not.toHaveBeenCalled()
    expect(out).toContain('network entries: 1')
    expect(out).toContain('200 GET https://example.com/api?token=*** 12ms')
  })

  it('prints console rows with location', async () => {
    const h = harness(() => true)
    const out = await h.run('browser_console') as string
    expect(out).toContain('console entries: 1')
    expect(out).toContain('[2] error: boom (https://example.com/app.js:10)')
  })

  it('rejects an unknown emulation value and passes known ones through', async () => {
    const h = harness(() => true)
    await expect(h.run('browser_emulate', { colorScheme: 'sepia' })).rejects.toThrow(/colorScheme must be one of/)
    const out = await h.run('browser_emulate', { colorScheme: 'dark' }) as string
    expect(h.driver.emulate).toHaveBeenCalledWith({ colorScheme: 'dark' })
    expect(out).toContain('emulated: colorScheme=dark')
  })

  it('requires at least one emulation argument', async () => {
    const h = harness(() => true)
    await expect(h.run('browser_emulate')).rejects.toThrow(/pass colorScheme, reducedMotion, or width\+height/)
  })
})
