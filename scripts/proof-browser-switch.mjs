/**
 * Proof: Playwright can switch chrome ↔ edge with separate profiles on this machine.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const chromeExe = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(existsSync)
const edgeExe = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync)

if (!chromeExe || !edgeExe) {
  console.error(JSON.stringify({ ok: false, chromeExe, edgeExe }))
  process.exit(1)
}

const root = join(tmpdir(), 'dsh-ba-switch-proof')
rmSync(root, { recursive: true, force: true })

async function once(kind, exe) {
  const dir = join(root, `profile-${kind}`)
  mkdirSync(dir, { recursive: true })
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: exe,
    headless: true,
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--no-sandbox'],
    args: ['--no-first-run', '--no-default-browser-check'],
  })
  await ctx.close()
  return { kind, exe, dir }
}

const a = await once('chrome', chromeExe)
const b = await once('edge', edgeExe)
const c = await once('chrome', chromeExe)
console.log(JSON.stringify({ ok: true, steps: [a.kind, b.kind, c.kind], chromeExe, edgeExe }))
