import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PlaywrightDriver } from '../src/host/browser-agent/playwright-driver.ts'
import { resolveBrowserExecutable } from '../src/host/browser-agent/launch.ts'

const hasSystemChromium = resolveBrowserExecutable('auto') !== null

const HOME = `<!doctype html>
<html><head><title>Home</title></head>
<body>
  <main>
    <a href="/next">Plain Next</a>
    <div class="card" style="position:relative;width:220px;height:120px;margin:24px;">
      <a href="/video/42" style="position:absolute;inset:0;" aria-label="cover"></a>
      <div role="link" style="position:relative;padding-top:72px;">Amazing SPA Card Title</div>
    </div>
    <button id="popup">Open Popup</button>
    <input id="name" placeholder="Your name" />
    <script>
      document.getElementById('popup').addEventListener('click', function () {
        window.open('/popup-target', '_blank');
      });
    </script>
  </main>
</body></html>`

const NEXT = `<!doctype html><html><head><title>Next</title></head><body><main>Arrived at next</main></body></html>`
const VIDEO = `<!doctype html><html><head><title>Video</title></head><body><main>Video body 42</main></body></html>`
const POPUP = `<!doctype html><html><head><title>Popup</title></head><body><main>Popup target</main></body></html>`

async function startServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = req.url || '/'
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (url === '/' || url.startsWith('/?')) {
      res.end(HOME)
      return
    }
    if (url.startsWith('/next')) {
      res.end(NEXT)
      return
    }
    if (url.startsWith('/video/')) {
      res.end(VIDEO)
      return
    }
    if (url.startsWith('/popup-target')) {
      res.end(POPUP)
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

describe('PlaywrightDriver act path', () => {
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

  it.skipIf(!hasSystemChromium)('navigates plain links, SPA cards, popups, and types', async () => {
    const { server, base } = await startServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pw-act-'))
    dirs.push(dir)
    const driver = new PlaywrightDriver({ profileDir: dir, headless: true })
    try {
      await driver.ensureReady()

      // Plain <a href>
      await driver.navigate(base + '/')
      let snap = await driver.snapshot()
      const plain = snap.nodes.find(n => n.name.includes('Plain Next') && n.href?.includes('/next'))
      expect(plain).toBeTruthy()
      const plainClick = await driver.click(plain!.ref)
      expect(plainClick.changed).toBe(true)
      expect(plainClick.url).toContain('/next')

      // role=link card with nearby overlay <a href>
      await driver.navigate(base + '/')
      snap = await driver.snapshot()
      const card = snap.nodes.find(n => n.name.includes('Amazing SPA Card Title') && n.href?.includes('/video/42'))
      expect(card).toBeTruthy()
      const cardClick = await driver.click(card!.ref)
      expect(cardClick.changed).toBe(true)
      expect(cardClick.url).toContain('/video/42')
      const extract = await driver.extract()
      expect(extract.text).toContain('Video body 42')

      // window.open popup without href on the control
      await driver.navigate(base + '/')
      snap = await driver.snapshot()
      const popupBtn = snap.nodes.find(n => n.name.includes('Open Popup') && n.role === 'button')
      expect(popupBtn).toBeTruthy()
      const popupClick = await driver.click(popupBtn!.ref)
      expect(popupClick.changed).toBe(true)
      expect(popupClick.url).toContain('/popup-target')

      // type into input
      await driver.navigate(base + '/')
      snap = await driver.snapshot()
      const input = snap.nodes.find(n => n.role === 'textbox' || n.name.includes('Your name'))
      expect(input).toBeTruthy()
      const typed = await driver.type(input!.ref, 'Ada Lovelace')
      expect(typed.url).toContain(base)
    } finally {
      await driver.dispose()
    }
  }, 120_000)
})
