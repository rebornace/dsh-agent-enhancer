import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PlaywrightDriver } from '../src/host/browser-agent/playwright-driver.ts'
import { resolveBrowserExecutable } from '../src/host/browser-agent/launch.ts'
import { replayDemoSteps } from '../src/host/browser-agent/demo-replay.ts'

const hasSystemChromium = resolveBrowserExecutable('auto') !== null

/** A single-page form: the button rewrites the URL with pushState. */
const FORM = `<!doctype html>
<html><head><title>Search</title></head>
<body>
  <main>
    <input id="q" name="q" aria-label="Search term" />
    <button id="go" type="button">Run search</button>
    <p id="out">idle</p>
    <script>
      document.getElementById('go').addEventListener('click', function () {
        document.getElementById('out').textContent = 'ran:' + document.getElementById('q').value;
        history.pushState({ ran: true }, '', '/done');
      });
    </script>
  </main>
</body></html>`

async function startServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(FORM)
  })
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve())
    server.on('error', reject)
  })
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no listen address')
  return { server, base: `http://127.0.0.1:${addr.port}` }
}

describe('demonstration replay', () => {
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

  it.skipIf(!hasSystemChromium)('records an SPA route and replays the flow on its own', async () => {
    const { server, base } = await startServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pw-replay-'))
    dirs.push(dir)
    const driver = new PlaywrightDriver({ profileDir: dir, headless: true })
    try {
      await driver.ensureReady()
      await driver.navigate(base + '/form')
      const form = await driver.snapshot()
      const input = form.nodes.find(node => node.role === 'textbox' && node.name.includes('Search term'))
      expect(input, 'text box should be in the snapshot').toBeTruthy()

      await driver.startDemonstration()
      await driver.type(input!.ref, 'quarterly report')
      const withButton = await driver.snapshot()
      const button = withButton.nodes.find(node => node.role === 'button' && node.name.includes('Run search'))
      expect(button, 'button should be in the snapshot').toBeTruthy()
      await driver.click(button!.ref)
      await new Promise(resolve => setTimeout(resolve, 500))
      const steps = await driver.stopDemonstration()

      // pushState never fires framenavigated; the recorder has to catch it.
      const routeStep = steps.find(step => step.kind === 'navigate' && step.url.includes('/done'))
      expect(routeStep, 'SPA route change should be a navigate step').toBeTruthy()
      expect(steps.some(step => step.kind === 'fill' && step.value === 'quarterly report')).toBe(true)

      // Back to a clean page, then replay the recording without a model turn.
      await driver.navigate(base + '/form')
      const replay = await replayDemoSteps(driver, steps)
      expect(replay.status, replay.status === 'blocked' ? replay.reason : '').toBe('done')
      const after = await driver.extract()
      expect(after.text).toContain('ran:quarterly report')
      expect((await driver.pageStatus()).url).toContain('/done')
    } finally {
      await driver.dispose()
    }
  }, 120_000)
})
