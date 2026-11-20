import { describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { AGENT_CHROMIUM_ARGS } from '../src/host/browser-agent/playwright-driver.ts'
import { resolveBrowserExecutable } from '../src/host/browser-agent/launch.ts'

const executable = resolveBrowserExecutable('auto')

describe('dedicated Chromium flags', () => {
  it('pins the automation flag that login gates read', () => {
    expect(AGENT_CHROMIUM_ARGS).toContain('--disable-blink-features=AutomationControlled')
    expect(AGENT_CHROMIUM_ARGS).toContain('--no-first-run')
  })

  it.skipIf(executable === null)('hides navigator.webdriver from the page', async () => {
    const browser = await chromium.launch({
      executablePath: executable!.executable,
      headless: true,
      args: [...AGENT_CHROMIUM_ARGS],
    })
    try {
      const page = await browser.newPage()
      await page.goto('data:text/html,<title>probe</title>')
      expect(await page.evaluate(() => navigator.webdriver)).toBe(false)
    } finally {
      await browser.close().catch(() => undefined)
    }
  }, 60_000)
})
