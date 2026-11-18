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
    private ready = false
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
      const channel = this.preference === 'edge' || this.preference === 'auto'
        ? 'msedge'
        : 'chrome'
      return {
        kind: 'playwright' as const,
        ready: this.ready,
        listening: this.ready,
        lastError: null,
        endpoint: this.ready ? `playwright:${channel}` : `playwright:unlaunched:${this.preference}`,
      }
    }
    ensureReady = async () => {
      this.ready = true
      ensureReady()
    }
    dispose = dispose
  }
  return { PlaywrightDriver: MockPlaywrightDriver }
})

vi.mock('../src/host/browser-agent/tools.ts', () => ({
  registerBrowserTools: (_ctx: unknown, options: {
    readonly alignPreference?: (startUrl?: string) => Promise<void>
    readonly driver: unknown
  }) => {
    // Expose align for the test via a side channel.
    ;(globalThis as { __baAlign?: typeof options.alignPreference }).__baAlign = options.alignPreference
    return () => undefined
  },
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

describe('Agent dialog preference align', () => {
  it('rebuilds the driver when live preference flips without Launch', async () => {
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

    // First Agent open → chrome
    await runtime.alignToPreference()
    expect(constructed.at(-1)?.preference).toBe('chrome')
    expect(runtime.driverStatus()?.endpoint).toBe('playwright:chrome')

    // User switches to Edge in settings/sidebar (live preference) — no Launch click.
    preference = 'edge'
    await runtime.alignToPreference()
    expect(dispose).toHaveBeenCalled()
    expect(constructed.at(-1)?.preference).toBe('edge')
    expect(runtime.driverStatus()?.endpoint).toBe('playwright:msedge')

    // Tools were registered with alignPreference — same path Agent browser_navigate uses.
    const align = (globalThis as { __baAlign?: (startUrl?: string) => Promise<void> }).__baAlign
    expect(typeof align).toBe('function')
    preference = 'chrome'
    await align!()
    expect(constructed.at(-1)?.preference).toBe('chrome')
    expect(runtime.driverStatus()?.endpoint).toBe('playwright:chrome')

    await runtime.dispose()
  })
})
