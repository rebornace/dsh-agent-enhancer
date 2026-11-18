import { describe, expect, it, vi } from 'vitest'
import type { BrowserDriver } from '../src/host/browser-agent/driver.ts'

function fakePlaywrightDriver(overrides: Partial<{
  ready: boolean
}> = {}): BrowserDriver {
  const ready = overrides.ready ?? true
  return {
    kind: 'playwright',
    status: () => ({
      kind: 'playwright',
      ready,
      listening: ready,
      lastError: null,
      endpoint: 'playwright:msedge',
    }),
    ensureReady: vi.fn(async () => undefined),
    pageStatus: vi.fn(async () => ({
      connected: true as const,
      url: 'https://example.com/',
      title: 'Example',
      tabId: 1,
      bound: true,
    })),
    navigate: vi.fn(async (url: string) => ({ url, title: 't', tabId: 1 })),
    snapshot: vi.fn(async () => ({
      url: 'https://example.com/',
      title: 'Example',
      nodes: [{ ref: 1, role: 'link', name: 'Home', href: 'https://example.com/' }],
      textPreview: 'home',
    })),
    extract: vi.fn(async () => ({
      url: 'https://example.com/',
      title: 'Example',
      text: 'body',
      truncated: false,
    })),
    click: vi.fn(async () => ({
      url: 'https://example.com/x',
      title: 'X',
      changed: true,
      tabId: 1,
    })),
    type: vi.fn(async () => ({
      url: 'https://example.com/',
      title: 'Example',
      changed: false,
      tabId: 1,
    })),
    scroll: vi.fn(async () => ({
      url: 'https://example.com/',
      title: 'Example',
      changed: false,
      tabId: 1,
    })),
    wait: vi.fn(async () => ({ url: 'https://example.com/', title: 'Example', matched: true })),
    screenshot: vi.fn(async () => ({ mime: 'image/png', base64: 'aa' })),
    listTabs: vi.fn(async () => ({ tabs: [], boundTabId: null })),
    startCapture: vi.fn(),
    sweepIdleTabs: vi.fn(async () => []),
    readCapture: vi.fn(() => ({ entries: [], dropped: 0 })),
    emulate: vi.fn(async () => ({
      url: 'https://example.com/',
      title: 'Example',
      applied: [],
      tabId: 1,
    })),
    followTab: vi.fn(async (tabId: number) => ({ tabId, url: 'https://example.com/', title: 'Example' })),
    bind: vi.fn(async (tabId: number) => ({ tabId, url: 'https://example.com/', title: 'Example' })),
    dispose: vi.fn(async () => undefined),
  }
}

describe('BrowserDriver contract (Playwright)', () => {
  it('reports playwright kind and readiness', () => {
    const driver = fakePlaywrightDriver({ ready: true })
    expect(driver.kind).toBe('playwright')
    expect(driver.status().ready).toBe(true)
    expect(driver.status().endpoint).toContain('playwright:')
  })

  it('exposes click/type/scroll on the driver surface', async () => {
    const driver = fakePlaywrightDriver()
    await driver.click(7)
    await driver.type(3, 'hi')
    await driver.scroll(-120)
    expect(driver.click).toHaveBeenCalledWith(7)
    expect(driver.type).toHaveBeenCalledWith(3, 'hi')
    expect(driver.scroll).toHaveBeenCalledWith(-120)
  })

  it('ensureReady is callable when not ready', async () => {
    const driver = fakePlaywrightDriver({ ready: false })
    await driver.ensureReady('https://example.com/')
    expect(driver.ensureReady).toHaveBeenCalledWith('https://example.com/')
  })
})
