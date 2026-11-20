import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PlaywrightDriver } from '../src/host/browser-agent/playwright-driver.ts'
import { resolveBrowserExecutable } from '../src/host/browser-agent/launch.ts'

const hasSystemChromium = resolveBrowserExecutable('auto') !== null

/** Tab A can open tab B; each tab has one button the demonstration clicks. */
const PAGE_A = `<!doctype html>
<html><head><title>A</title></head>
<body>
  <main>
    <button id="open">Open second tab</button>
    <button id="a-step">Mark A</button>
    <script>
      document.getElementById('open').addEventListener('click', function () {
        window.open('/b', '_blank');
      });
    </script>
  </main>
</body></html>`

const PAGE_B = `<!doctype html>
<html><head><title>B</title></head>
<body><main><button id="b-step">Mark B</button></main></body></html>`

async function startServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = req.url || '/'
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (url.startsWith('/a')) {
      res.end(PAGE_A)
      return
    }
    if (url.startsWith('/b')) {
      res.end(PAGE_B)
      return
    }
    res.statusCode = 404
    res.end('missing')
  })
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve())
    server.on('error', reject)
  })
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no listen address')
  return { server, base: `http://127.0.0.1:${addr.port}` }
}

async function clickByName(driver: PlaywrightDriver, name: string): Promise<void> {
  const snap = await driver.snapshot()
  const node = snap.nodes.find(entry => entry.name.includes(name))
  expect(node, `no snapshot node named ${name}`).toBeTruthy()
  await driver.click(node!.ref)
}

describe('demonstration across tabs', () => {
  const dirs: string[] = []
  const servers: Server[] = []

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop()
      if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    }
    while (dirs.length > 0) {
      const dir = dirs.pop()
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
  })

  it.skipIf(!hasSystemChromium)('records a tab the user opened before recording started', async () => {
    const { server, base } = await startServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pw-demo-'))
    dirs.push(dir)
    const driver = new PlaywrightDriver({ profileDir: dir, headless: true })
    try {
      await driver.ensureReady()
      const opened = await driver.navigate(base + '/a')
      const tabA = opened.tabId
      expect(tabA).toBeTypeOf('number')

      // Tab B is created before the demonstration, so it is a pre-existing tab.
      await clickByName(driver, 'Open second tab')
      const tabs = await driver.listTabs()
      const tabB = tabs.tabs.find(tab => tab.url.includes('/b'))?.tabId
      expect(tabB, 'tab B should be listed').toBeTypeOf('number')
      expect(tabB).not.toBe(tabA)

      // Bound page is B; recording starts here, then the user works in A as well.
      await driver.startDemonstration()
      await driver.followTab(tabA!)
      await clickByName(driver, 'Mark A')
      await driver.navigate(base + '/a?step=2')
      await driver.followTab(tabB!)
      await clickByName(driver, 'Mark B')
      await new Promise(resolve => setTimeout(resolve, 400))

      const steps = await driver.stopDemonstration()
      const clicks = steps.filter(step => step.kind === 'click')
      const inA = clicks.find(step => step.tabId === tabA)
      const inB = clicks.find(step => step.tabId === tabB)
      expect(inA, 'click in tab A was recorded').toBeTruthy()
      expect(inB, 'click in tab B was recorded').toBeTruthy()
      expect(inA!.tabUrl).toContain('/a')
      expect(inB!.tabUrl).toContain('/b')

      const nav = steps.find(step => step.kind === 'navigate' && step.url.includes('step=2'))
      expect(nav, 'navigation in tab A was recorded').toBeTruthy()
      expect(nav!.tabId).toBe(tabA)
    } finally {
      await driver.dispose()
    }
  }, 120_000)

  it.skipIf(!hasSystemChromium)('describes a ref well enough to repair a flow later', async () => {
    const { server, base } = await startServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pw-ref-'))
    dirs.push(dir)
    const driver = new PlaywrightDriver({ profileDir: dir, headless: true })
    try {
      await driver.ensureReady()
      await driver.navigate(base + '/a')
      const snap = await driver.snapshot()
      const node = snap.nodes.find(entry => entry.name.includes('Mark A'))
      expect(node, 'button should be in the snapshot').toBeTruthy()
      const info = await driver.refInfo(node!.ref)
      expect(info, 'refInfo should describe the ref').not.toBeNull()
      expect(info!.role).toBe('button')
      expect(info!.name).toContain('Mark A')
      expect(info!.selector).not.toBe('')
      // The recorded selector has to point back at the same element, otherwise a
      // repaired flow cannot disambiguate two same-named controls.
      expect(await driver.resolveRefBySelector(info!.selector)).toBe(node!.ref)
    } finally {
      await driver.dispose()
    }
  }, 120_000)
})
