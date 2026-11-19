import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PlaywrightDriver } from '../src/host/browser-agent/playwright-driver.ts'
import { resolveBrowserExecutable } from '../src/host/browser-agent/launch.ts'

const hasSystemChromium = resolveBrowserExecutable('auto') !== null

const PAGE = `<!doctype html>
<html><head><title>Thumb</title></head>
<body><main>
  <button id="export" style="padding:14px 22px;font-size:16px;">导出报表</button>
</main></body></html>`

async function startServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(PAGE)
  })
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve())
    server.on('error', reject)
  })
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no listen address')
  return { server, base: `http://127.0.0.1:${addr.port}` }
}

describe('approval thumbnail', () => {
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

  it.skipIf(!hasSystemChromium)('crops the control instead of the whole page', async () => {
    const { server, base } = await startServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pw-thumb-'))
    dirs.push(dir)
    const driver = new PlaywrightDriver({ profileDir: dir, headless: true })
    try {
      await driver.ensureReady()
      await driver.navigate(base + '/')
      const snap = await driver.snapshot()
      const button = snap.nodes.find(node => node.name.includes('导出报表'))
      expect(button, 'button should be in the snapshot').toBeTruthy()

      const thumb = await driver.thumbnail(button!.ref)
      expect(thumb).not.toBeNull()
      expect(thumb!.mime).toBe('image/jpeg')
      // JPEG magic in base64.
      expect(thumb!.base64.startsWith('/9j/')).toBe(true)
      // A crop, not a full screenshot: a 1280x800 page would be far larger.
      expect(thumb!.base64.length).toBeLessThan(120_000)

      // A ref that was never captured has no preview.
      const full = await driver.screenshot()
      expect(thumb!.base64.length).toBeLessThan(full.base64.length / 2)
      expect(await driver.thumbnail(99_999)).toBeNull()
    } finally {
      await driver.dispose()
    }
  }, 120_000)
})
