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

function harness(body: SnapshotBody) {
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
    pageStatus: async () => ({ connected: true, url: body.url, title: body.title, tabId: 1, bound: true }),
    bind: async (tabId: number) => ({ tabId, url: body.url, title: body.title }),
    followTab: async (tabId: number) => ({ tabId, url: body.url, title: body.title }),
    snapshot: async () => body,
    listTabs: async () => ({ tabs: [], boundTabId: null }),
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
  const tool = tools.get('browser_snapshot')
  if (tool === undefined) throw new Error('browser_snapshot not registered')
  return tool.execute({}, exec) as Promise<string>
}

describe('snapshot output', () => {
  it('echoes emulation and harvest counters', async () => {
    const out = await harness({
      url: 'https://example.com/',
      title: 'Example',
      tabId: 3,
      textPreview: 'preview',
      nodes: [{ ref: 1, role: 'link', name: 'Home', tag: 'a', href: 'https://example.com/' }],
      harvest: { interactive: 74, controls: 6, anchors: 12 },
      emulation: { colorScheme: 'dark', viewport: { width: 900, height: 700 } },
    })
    expect(out).toContain('harvest: interactive=74 controls=6 anchors=12')
    expect(out).toContain('emulation: colorScheme=dark viewport=900x700')
  })

  it('omits both lines when the driver reports neither', async () => {
    const out = await harness({
      url: 'https://example.com/',
      title: 'Example',
      tabId: 3,
      textPreview: 'preview',
      nodes: [{ ref: 1, role: 'link', name: 'Home', tag: 'a', href: 'https://example.com/' }],
    })
    expect(out).not.toContain('emulation:')
    expect(out).not.toContain('harvest:')
  })

  it('counts links and controls so a link-heavy list cannot read as "all links"', async () => {
    const out = await harness({
      url: 'https://example.com/',
      title: 'Example',
      tabId: 3,
      textPreview: '',
      nodes: [
        { ref: 1, role: 'link', name: 'A', tag: 'a', href: 'https://example.com/a' },
        { ref: 2, role: 'link', name: 'B', tag: 'a', href: 'https://example.com/b' },
        { ref: 3, role: 'button', name: 'Search', tag: 'button' },
      ],
    })
    expect(out).toContain('interactive (3 shown: 2 link / 1 control')
    expect(out).toContain('controls listed first')
  })
})
