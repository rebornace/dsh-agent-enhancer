import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SoftPauseGate } from '../soft-pause/gate.ts'

const disposeCalls: Array<() => void> = []

vi.mock('./playwright-driver.ts', () => ({
  PlaywrightDriver: class {
    status() {
      return { ready: false, endpoint: null }
    }
    async dispose() {
      // no-op
    }
    async ensureReady() {
      // no-op
    }
  },
}))

vi.mock('./launch.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./launch.ts')>()
  return {
    ...actual,
    stopAgentBrowserProcesses: () => undefined,
  }
})

vi.mock('./prompt.ts', () => ({
  registerBrowserAgentPrompt: () => {
    let alive = true
    const dispose = () => { alive = false }
    disposeCalls.push(dispose)
    return () => { dispose() }
  },
}))

vi.mock('./tools.ts', () => ({
  registerBrowserTools: () => {
    let alive = true
    const dispose = () => { alive = false }
    ;(dispose as { alive?: () => boolean }).alive = () => alive
    disposeCalls.push(dispose)
    return () => { alive = false }
  },
}))

import { installBrowserAgent } from './install.ts'

function mockCtx(): Context {
  return {
    logger: { warn: () => undefined, info: () => undefined, error: () => undefined },
    get: () => undefined,
  } as unknown as Context
}

function softPauseStub(): SoftPauseGate {
  return {
    retain: () => undefined,
    release: () => undefined,
    isPaused: () => false,
  } as unknown as SoftPauseGate
}

describe('installBrowserAgent refresh', () => {
  afterEach(() => {
    disposeCalls.length = 0
    vi.clearAllMocks()
  })

  it('registers tools when enabled at install', () => {
    const profileRoot = mkdtempSync(join(tmpdir(), 'ba-refresh-'))
    let enabled = true
    const runtime = installBrowserAgent(mockCtx(), {
      enabled: () => enabled,
      browserPreference: () => 'chrome',
      profileRoot,
      softPause: softPauseStub(),
      softPauseEnabled: () => false,
    })
    expect(disposeCalls.length).toBeGreaterThanOrEqual(2)
    void runtime.dispose()
  })

  it('remounts tools after disable→enable even if teardown is async', async () => {
    const profileRoot = mkdtempSync(join(tmpdir(), 'ba-refresh-'))
    let enabled = true
    const runtime = installBrowserAgent(mockCtx(), {
      enabled: () => enabled,
      browserPreference: () => 'chrome',
      profileRoot,
      softPause: softPauseStub(),
      softPauseEnabled: () => false,
    })
    const mountedBefore = disposeCalls.length
    expect(mountedBefore).toBeGreaterThanOrEqual(2)

    enabled = false
    runtime.refresh()
    // Re-enable while async teardown may still be pending (switchPending path).
    enabled = true
    runtime.refresh()
    await new Promise<void>(resolve => setTimeout(resolve, 30))

    // Tools must be registered again after teardown finishes.
    expect(disposeCalls.length).toBeGreaterThan(mountedBefore)
    await runtime.dispose()
  })

  it('keeps tools registered across repeated refresh while enabled', async () => {
    const profileRoot = mkdtempSync(join(tmpdir(), 'ba-refresh-'))
    const runtime = installBrowserAgent(mockCtx(), {
      enabled: () => true,
      browserPreference: () => 'chrome',
      profileRoot,
      softPause: softPauseStub(),
      softPauseEnabled: () => false,
    })
    const before = disposeCalls.length
    runtime.refresh()
    runtime.refresh()
    expect(disposeCalls.length).toBe(before)
    await runtime.dispose()
  })

  it('listTabs returns empty when driver is not ready (no auto-launch)', async () => {
    const profileRoot = mkdtempSync(join(tmpdir(), 'ba-refresh-'))
    const runtime = installBrowserAgent(mockCtx(), {
      enabled: () => true,
      browserPreference: () => 'chrome',
      profileRoot,
      softPause: softPauseStub(),
      softPauseEnabled: () => false,
    })
    await expect(runtime.listTabs()).resolves.toEqual({ tabs: [], boundTabId: null })
    await runtime.dispose()
  })
})
