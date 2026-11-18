import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { capturePlaywrightSnapshot } from '../src/host/browser-agent/playwright-snapshot.ts'
import { resolveBrowserExecutable } from '../src/host/browser-agent/launch.ts'

const hasSystemChromium = resolveBrowserExecutable('auto') !== null
const resolved = resolveBrowserExecutable('auto')

const FIXTURE = `<!doctype html>
<html><head><title>Fixture</title></head>
<body>
  <main>
    <a href="https://example.com/nav">Home</a>
    <div class="card" style="position:relative;width:200px;height:120px;margin:40px;">
      <a href="https://example.com/video/42" style="position:absolute;inset:0;" aria-label="cover"></a>
      <div role="link" style="position:relative;padding-top:80px;">Amazing SPA Card Title</div>
    </div>
    <p>Preview text for extract.</p>
  </main>
</body></html>`

describe('capturePlaywrightSnapshot', () => {
  const dirs: string[] = []

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop()
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
  })

  it.skipIf(!hasSystemChromium || resolved === null)(
    'binds href onto role=link cards via nearby anchors',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-pw-snap-'))
      dirs.push(dir)
      const channel = resolved!.kind === 'edge' ? 'msedge' : 'chrome'
      const context = await chromium.launchPersistentContext(dir, {
        channel,
        headless: true,
        viewport: { width: 1280, height: 800 },
      })
      try {
        const page = context.pages()[0] ?? await context.newPage()
        await page.setContent(FIXTURE, { waitUntil: 'domcontentloaded' })
        const { body, refs } = await capturePlaywrightSnapshot(page)

        expect(body.source).toMatch(/playwright/)
        expect((body.anchorCount ?? 0) >= 1).toBe(true)
        expect(body.nodes.some(n => typeof n.href === 'string' && n.href.includes('/video/42'))).toBe(true)
        expect(
          body.nodes.some(n => n.name.includes('Amazing SPA Card Title') && n.href?.includes('/video/42')),
        ).toBe(true)
        expect(refs.size).toBe(body.nodes.length)
        expect(body.textPreview).toContain('Preview text')
      } finally {
        await context.close()
      }
    },
    60_000,
  )
})
