import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PlaywrightDriver } from '../src/host/browser-agent/playwright-driver.ts'
import { resolveBrowserExecutable } from '../src/host/browser-agent/launch.ts'

const hasSystemChromium = resolveBrowserExecutable('auto') !== null

describe('PlaywrightDriver scaffold', () => {
  const dirs: string[] = []

  afterEach(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop()
      if (dir === undefined) break
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })

  it('reports playwright kind before launch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pw-'))
    dirs.push(dir)
    const driver = new PlaywrightDriver({ profileDir: dir })
    expect(driver.kind).toBe('playwright')
    expect(driver.status().ready).toBe(false)
    expect(driver.status().endpoint).toContain('playwright:')
  })

  it.skipIf(!hasSystemChromium)('ensureReady launches a persistent context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pw-'))
    dirs.push(dir)
    const driver = new PlaywrightDriver({ profileDir: dir, preference: 'auto', headless: true })
    try {
      await driver.ensureReady('about:blank')
      expect(driver.status().ready).toBe(true)
      const status = await driver.pageStatus()
      expect(status.connected).toBe(true)
      expect(typeof status.url).toBe('string')
    } finally {
      await driver.dispose()
    }
  }, 60_000)
})
