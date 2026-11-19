import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { PlaywrightDriver } from '../src/host/browser-agent/playwright-driver.ts'
import { resolveBrowserExecutable } from '../src/host/browser-agent/launch.ts'
import { BrowserApprovalGate, type BrowserApprovalRequest } from '../src/host/browser-agent/approval.ts'
import { BrowserHumanGate } from '../src/host/browser-agent/human-gate.ts'
import { BrowserSessionState } from '../src/host/browser-agent/session-state.ts'
import { registerBrowserTools } from '../src/host/browser-agent/tools.ts'
import type { BrowserDriver } from '../src/host/browser-agent/driver.ts'

const hasSystemChromium = resolveBrowserExecutable('auto') !== null

const PAGE = `<!doctype html>
<html><head><title>Approve</title></head>
<body><main>
  <a id="go" href="/done" style="display:inline-block;padding:16px 24px;font-size:18px;">导出报表</a>
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

interface RegisteredTool {
  readonly name: string
  execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>
}

describe('approval card preview', () => {
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

  it.skipIf(!hasSystemChromium)('hands a crop of the clicked control to the gate', async () => {
    const { server, base } = await startServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pw-approve-'))
    dirs.push(dir)
    const driver = new PlaywrightDriver({ profileDir: dir, headless: true })
    const tools = new Map<string, RegisteredTool>()
    const ctx = {
      tools: {
        register(tool: RegisteredTool) {
          tools.set(tool.name, tool)
          return () => tools.delete(tool.name)
        },
      },
    } as unknown as Context
    const gate = new BrowserApprovalGate()
    const seen: Array<BrowserApprovalRequest['thumbnail']> = []
    gate.setListener(request => {
      if (request === null) return
      seen.push(request.thumbnail)
      gate.resolve(request.id, 'allow-once')
    })
    try {
      await driver.ensureReady()
      await driver.navigate(base + '/')
      registerBrowserTools(ctx, {
        driver: driver as unknown as BrowserDriver,
        approval: gate as never,
        human: new BrowserHumanGate(),
        sessions: new BrowserSessionState(),
        enabled: () => true,
      })
      const exec = { agent: { session: { id: 's1' } }, signal: new AbortController().signal }
      await tools.get('browser_snapshot')!.execute({}, exec)
      await tools.get('browser_click')!.execute({ ref: 1 }, exec)

      expect(seen, 'one approval should have been requested').toHaveLength(1)
      const thumb = seen[0]
      expect(thumb, 'the approval should carry a preview').toBeTruthy()
      expect(thumb!.mime).toBe('image/jpeg')
      expect(thumb!.base64.startsWith('/9j/')).toBe(true)
      expect(thumb!.base64.length).toBeGreaterThan(500)
    } finally {
      await driver.dispose()
    }
  }, 120_000)
})
