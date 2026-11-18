import { describe, expect, it, vi } from 'vitest'
import { installBrowserAgent } from '../src/host/browser-agent/install.ts'
import type { SoftPauseGate } from '../src/host/soft-pause/gate.ts'

const ensureReady = vi.fn(async () => undefined)
const dispose = vi.fn(async () => undefined)
const constructed: Array<{ preference: string }> = []

vi.mock('../src/host/browser-agent/playwright-driver.ts', () => {
  class MockPlaywrightDriver {
    readonly kind = 'playwright' as const
    readonly preference: string
    constructor(options: {
      readonly preference?: string | (() => string)
      readonly profileDir: string | (() => string)
      readonly profileRoot?: string
    }) {
      this.preference = typeof options.preference === 'function'
        ? options.preference()
        : (options.preference ?? 'auto')
      constructed.push({ preference: this.preference })
    }
    status() {
      return {
        kind: 'playwright' as const,
        ready: false,
        listening: false,
        lastError: null,
        endpoint: `playwright:unlaunched:${this.preference}`,
      }
    }
    ensureReady = ensureReady
    dispose = dispose
  }
  return { PlaywrightDriver: MockPlaywrightDriver }
})

vi.mock('../src/host/browser-agent/tools.ts', () => ({
  registerBrowserTools: () => () => undefined,
}))

vi.mock('../src/host/browser-agent/prompt.ts', () => ({
  registerBrowserAgentPrompt: () => () => undefined,
}))

vi.mock('../src/host/browser-agent/launch.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/host/browser-agent/launch.ts')>()
  return {
    ...actual,
    stopAgentBrowserProcesses: () => undefined,
  }
})

function mockCtx() {
  return {
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as never
}

describe('browser launch preference', () => {
  it('hard-resets driver with the override on every launchDedicated call', async () => {
    constructed.length = 0
    ensureReady.mockClear()
    dispose.mockClear()

    let preference: 'auto' | 'chrome' | 'edge' = 'chrome'
    const softPause = { release: vi.fn() } as unknown as SoftPauseGate
    const runtime = installBrowserAgent(mockCtx(), {
      enabled: () => true,
      browserPreference: () => preference,
      profileRoot: 'C:\\plugin-data',
      softPause,
      softPauseEnabled: () => false,
    })

    expect(constructed[0]?.preference).toBe('chrome')

    // Changing settings preference alone must NOT remount (Launch owns the switch).
    preference = 'edge'
    runtime.refresh()
    expect(constructed).toHaveLength(1)

    await runtime.launchDedicated(undefined, 'edge')
    expect(dispose).toHaveBeenCalled()
    expect(constructed.map(entry => entry.preference)).toEqual(['chrome', 'edge'])
    expect(ensureReady).toHaveBeenCalledTimes(1)

    await runtime.launchDedicated(undefined, 'chrome')
    expect(constructed.map(entry => entry.preference)).toEqual(['chrome', 'edge', 'chrome'])
    expect(ensureReady).toHaveBeenCalledTimes(2)

    await runtime.dispose()
  })
})
