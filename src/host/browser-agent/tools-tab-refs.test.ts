import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserDriver } from './driver.ts'
import type { SnapshotBody } from './protocol.ts'
import { BrowserSessionState } from './session-state.ts'
import { registerBrowserTools } from './tools.ts'

interface RegisteredTool {
  readonly name: string
  execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>
}

function snapshot(tabId: number, refs: readonly number[]): SnapshotBody {
  return {
    url: `https://example.com/tab-${tabId}`,
    title: `Tab ${tabId}`,
    tabId,
    textPreview: 'preview',
    nodes: refs.map(ref => ({ ref, role: 'link', name: `link-${ref}`, tag: 'a', href: `https://example.com/${ref}` })),
  }
}

function harness() {
  const tools = new Map<string, RegisteredTool>()
  const ctx = {
    tools: {
      register(tool: RegisteredTool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
  } as unknown as Context

  let current = 1
  const clicks: number[] = []
  const driver = {
    kind: 'playwright',
    status: () => ({ kind: 'playwright', ready: true, listening: true }),
    ensureReady: async () => undefined,
    pageStatus: async () => ({
      connected: true,
      url: `https://example.com/tab-${current}`,
      title: `Tab ${current}`,
      tabId: current,
      bound: true,
    }),
    listTabs: async () => ({
      tabs: [1, 2].map(tabId => ({
        tabId,
        title: `Tab ${tabId}`,
        url: `https://example.com/tab-${tabId}`,
        active: tabId === current,
        bound: false,
        readOnly: false,
      })),
      boundTabId: current,
    }),
    bind: async (tabId: number) => {
      current = tabId
      return { tabId, url: `https://example.com/tab-${tabId}`, title: `Tab ${tabId}` }
    },
    followTab: async (tabId: number) => {
      current = tabId
      return { tabId, url: `https://example.com/tab-${tabId}`, title: `Tab ${tabId}` }
    },
    navigate: async (url: string, options?: { newTab?: boolean }) => {
      if (options?.newTab === true) current = 2
      return { url, title: `Tab ${current}`, tabId: current }
    },
    snapshot: async () => snapshot(current, current === 1 ? [1, 2, 3] : [9, 10]),
    click: async (ref: number) => {
      clicks.push(ref)
      return { url: `https://example.com/tab-${current}`, title: `Tab ${current}`, changed: true, tabId: current }
    },
    listTabsFor: () => current,
  } as unknown as BrowserDriver

  const sessions = new BrowserSessionState()
  registerBrowserTools(ctx, {
    driver,
    approval: { requestApproval: async () => 'allow', current: () => null } as never,
    human: { current: () => null } as never,
    sessions,
    enabled: () => true,
  })

  const exec = { agent: { session: { id: 's1' } }, signal: new AbortController().signal }
  return {
    clicks,
    sessions,
    run: (name: string, args: Record<string, unknown> = {}) => {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`tool ${name} not registered`)
      return tool.execute(args, exec)
    },
  }
}

describe('refs follow their tab', () => {
  it('clicks a ref from tab 1 after switching away and back, without a new snapshot', async () => {
    const h = harness()
    await h.run('browser_snapshot')
    expect(h.sessions.tabOf('s1')).toBe(1)

    await h.run('browser_navigate', { url: 'https://example.com/other', newTab: true })
    await h.run('browser_snapshot')
    expect(h.sessions.tabOf('s1')).toBe(2)

    await h.run('browser_follow_tab', { tabId: 1 })
    await expect(h.run('browser_click', { ref: 1 })).resolves.toBeTruthy()
    expect(h.clicks).toEqual([1])
  })

  it('names the owning tab when a ref from the other tab is used', async () => {
    const h = harness()
    await h.run('browser_snapshot')
    await h.run('browser_navigate', { url: 'https://example.com/other', newTab: true })
    await h.run('browser_snapshot')

    await h.run('browser_follow_tab', { tabId: 1 })
    await expect(h.run('browser_click', { ref: 9 })).rejects.toThrow(/ref 9 belongs to tab 2/)
    expect(h.clicks).toEqual([])
  })

  it('forgets the refs of a tab once it is closed', async () => {
    const h = harness()
    await h.run('browser_snapshot')
    h.sessions.unbindTab(1)
    await expect(h.run('browser_click', { ref: 1 })).rejects.toThrow(/not from a browser_snapshot/)
  })
})
