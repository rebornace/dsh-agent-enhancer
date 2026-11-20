import { describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { AGENT_CHROMIUM_ARGS, hideWebdriver } from '../src/host/browser-agent/playwright-driver.ts'
import { resolveBrowserExecutable } from '../src/host/browser-agent/launch.ts'

const executable = resolveBrowserExecutable('auto')

describe('dedicated browser fingerprint', () => {
  it('hides the webdriver flag without a command-line warning', () => {
    // The flag route paints "unsupported command-line flag" in Chrome; keep it out.
    expect(AGENT_CHROMIUM_ARGS.some(arg => arg.includes('disable-blink-features'))).toBe(false)
    expect(AGENT_CHROMIUM_ARGS).toContain('--no-first-run')
    expect(typeof hideWebdriver).toBe('function')
  })

  it.skipIf(executable === null)('clears navigator.webdriver for page scripts', async () => {
    const browser = await chromium.launch({
      executablePath: executable!.executable,
      headless: true,
      args: [...AGENT_CHROMIUM_ARGS],
    })
    try {
      const context = await browser.newContext()
      await context.addInitScript(hideWebdriver)
      const page = await context.newPage()
      await page.goto('data:text/html,<title>probe</title>')
      expect(await page.evaluate(() => navigator.webdriver)).toBe(false)
    } finally {
      await browser.close().catch(() => undefined)
    }
  }, 60_000)
})
