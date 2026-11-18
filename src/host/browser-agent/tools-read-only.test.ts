import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserDriver } from './driver.ts'
import { BrowserSessionState } from './session-state.ts'
import { TabScopeStore } from './tab-scope.ts'
import { registerBrowserTools } from './tools.ts'

interface RegisteredTool {
  readonly name: string
  execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>
}

function harness() {
  const tools = new Map<string, RegisteredTool>()
  const ctx = {
    tools: {
      register(tool: RegisteredTool) {
        tools.set(tool.name, tool)
        return () => {
          tools.delete(tool.name)
        }
      },
    },
  } as unknown as Context

  const calls: string[] = []
  const driver = {
    kind: 'playwright',
    status: () => ({ kind: 'playwright', ready: true, listening: true }),
    ensureReady: async () => undefined,
    bind: async (tabId: number) => {
      calls.push(`bind:${tabId}`)
      return { tabId, url: 'https://example.com/inbox', title: 'Inbox' }
    },
    followTab: async (tabId: number) => {
      calls.push(`follow:${tabId}`)
      return { tabId, url: 'https://example.com/inbox', title: 'Inbox' }
    },
    pageStatus: async () => ({ connected: true, url: 'https://example.com/inbox', title: 'Inbox', tabId: 5, bound: true }),
    click: async () => {
      calls.push('click')
      return { url: 'https://example.com/done', title: 'Done', changed: true, tabId: 5 }
    },
    scroll: async () => {
      calls.push('scroll')
      return { url: 'https://example.com/inbox', title: 'Inbox', changed: false, tabId: 5 }
    },
    navigate: async (url: string) => {
      calls.push(`navigate:${url}`)
      return { url, title: 'Inbox', tabId: 5 }
    },
    listTabs: async () => ({ tabs: [], boundTabId: null }),
  } as unknown as BrowserDriver

  const sessions = new BrowserSessionState()
  sessions.bind('s1', 5)
  sessions.setLastRefs('s1', [1, 2])
  const tabScope = new TabScopeStore()

  registerBrowserTools(ctx, {
    driver,
    approval: {
      requestApproval: async () => 'allow',
      current: () => null,
    } as never,
    human: { current: () => null } as never,
    sessions,
    tabScope,
    enabled: () => true,
  })

  const exec = { agent: { session: { id: 's1' } }, signal: new AbortController().signal }
  const run = (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name)
    if (tool === undefined) throw new Error(`tool ${name} not registered`)
    return tool.execute(args, exec)
  }

  return { run, calls, tabScope, tools }
}

describe('read-only tab guard', () => {
  it('blocks click and type without touching the page', async () => {
    const h = harness()
    h.tabScope.setReadOnly(5, true)

    await expect(h.run('browser_click', { ref: 1 })).rejects.toThrow(/tab_read_only/)
    await expect(h.run('browser_type', { ref: 1, text: 'hi' })).rejects.toThrow(/tab_read_only/)
    expect(h.calls).not.toContain('click')
  })

  it('blocks in-tab navigation but allows opening a new tab', async () => {
    const h = harness()
    h.tabScope.setReadOnly(5, true)

    await expect(h.run('browser_navigate', { url: 'https://example.com/next' }))
      .rejects.toThrow(/tab_read_only/)
    expect(h.calls).not.toContain('navigate:https://example.com/next')

    await expect(h.run('browser_navigate', { url: 'https://example.com/new', newTab: true }))
      .resolves.toBeTruthy()
    expect(h.calls).toContain('navigate:https://example.com/new')
  })

  it('keeps reading and scrolling available', async () => {
    const h = harness()
    h.tabScope.setReadOnly(5, true)
    expect(h.tools.get('browser_scroll')).toBeDefined()
    expect(h.tools.get('browser_snapshot')).toBeDefined()
    await expect(h.run('browser_scroll', { dy: 200 })).resolves.toBeTruthy()
  })

  it('lets writes through once the tab is unlocked', async () => {
    const h = harness()
    h.tabScope.setReadOnly(5, true)
    await expect(h.run('browser_click', { ref: 1 })).rejects.toThrow(/tab_read_only/)

    h.tabScope.setReadOnly(5, false)
    await expect(h.run('browser_click', { ref: 1 })).resolves.toBeTruthy()
    expect(h.calls).toContain('click')
  })
})
