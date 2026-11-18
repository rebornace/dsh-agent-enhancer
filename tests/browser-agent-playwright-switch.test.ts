import { beforeEach, describe, expect, it, vi } from 'vitest'

const launchPersistentContext = vi.fn()
const stopAgentBrowserProcesses = vi.fn()

vi.mock('playwright-core', () => ({
  chromium: {
    launchPersistentContext: (...args: unknown[]) => launchPersistentContext(...args),
  },
}))

vi.mock('../src/host/browser-agent/launch.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/host/browser-agent/launch.ts')>()
  return {
    ...actual,
    stopAgentBrowserProcesses: (...args: unknown[]) => stopAgentBrowserProcesses(...args),
    resolveBrowserExecutable: (preference: 'chrome' | 'edge' | 'auto') => {
      if (preference === 'chrome') {
        return { kind: 'chrome' as const, executable: 'C:\\Chrome\\chrome.exe' }
      }
      if (preference === 'edge') {
        return { kind: 'edge' as const, executable: 'C:\\Edge\\msedge.exe' }
      }
      return { kind: 'edge' as const, executable: 'C:\\Edge\\msedge.exe' }
    },
  }
})

import { PlaywrightDriver } from '../src/host/browser-agent/playwright-driver.ts'
import { playwrightChannelOrder } from '../src/host/browser-agent/launch.ts'

describe('browser switch launch targets', () => {
  it('locks channel order without fallback for explicit preference', () => {
    expect(playwrightChannelOrder('chrome')).toEqual(['chrome'])
    expect(playwrightChannelOrder('edge')).toEqual(['msedge'])
  })
})

describe('PlaywrightDriver preference getter relaunch', () => {
  beforeEach(() => {
    launchPersistentContext.mockReset()
    stopAgentBrowserProcesses.mockReset()
    launchPersistentContext.mockImplementation(async (_dir: string, opts: { executablePath: string }) => {
      const page = {
        url: () => 'about:blank',
        goto: vi.fn(async () => undefined),
        isClosed: () => false,
        title: async () => '',
      }
      return {
        pages: () => [page],
        newPage: async () => page,
        close: vi.fn(async () => undefined),
        on: vi.fn(),
        browser: () => null,
        _exe: opts.executablePath,
      }
    })
  })

  it('relaunches when live preference flips while a context is open', async () => {
    let preference: 'chrome' | 'edge' = 'chrome'
    const driver = new PlaywrightDriver({
      preference: () => preference,
      profileDir: () => `C:\\profiles\\${preference}`,
      profileRoot: 'C:\\profiles-root',
      headless: true,
    })

    await driver.ensureReady()
    expect(launchPersistentContext).toHaveBeenCalledTimes(1)
    expect(String(launchPersistentContext.mock.calls[0]![1].executablePath)).toContain('chrome.exe')
    expect(driver.status().endpoint).toBe('playwright:chrome')

    preference = 'edge'
    await driver.ensureReady()
    expect(launchPersistentContext).toHaveBeenCalledTimes(2)
    expect(String(launchPersistentContext.mock.calls[1]![1].executablePath)).toContain('msedge.exe')
    expect(driver.status().endpoint).toBe('playwright:msedge')

    await driver.dispose()
  })
})
