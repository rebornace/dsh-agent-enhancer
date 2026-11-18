/**
 * Real Chrome↔Edge switch + orphan kill on this machine (Windows).
 * Skips when browsers are missing.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  browserAgentProfileDirFor,
  commandLineReferencesProfile,
  resolveBrowserExecutable,
  stopAgentBrowserProcesses,
} from '../src/host/browser-agent/launch.ts'
import { PlaywrightDriver } from '../src/host/browser-agent/playwright-driver.ts'

const chrome = resolveBrowserExecutable('chrome')
const edge = resolveBrowserExecutable('edge')
const canRun = process.platform === 'win32' && chrome !== null && edge !== null

function countProfileProcs(profileDir: string): number {
  const needle = profileDir.replace(/\\/g, '/').toLowerCase().replace(/'/g, "''")
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          '$ErrorActionPreference = "SilentlyContinue"',
          `$needle = '${needle}'`,
          '(Get-CimInstance Win32_Process |'
          + " Where-Object { ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -and"
          + ' (($_.CommandLine -replace "\\\\","/").ToLowerInvariant().IndexOf($needle) -ge 0) }).Count',
        ].join('; '),
      ],
      { encoding: 'utf8', timeout: 8_000, windowsHide: true },
    )
    return Number.parseInt(out.trim(), 10) || 0
  } catch {
    return -1
  }
}

describe.skipIf(!canRun)('browser agent chrome↔edge e2e', () => {
  const profileRoot = join(tmpdir(), `dsh-ba-e2e-${Date.now()}`)

  afterAll(() => {
    rmSync(profileRoot, { recursive: true, force: true })
  })

  it('normalizes slash for Win32 command-line match', () => {
    expect(commandLineReferencesProfile(
      '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir=C:\\Users\\x\\plugin-data\\browser-agent\\profile-chrome',
      'C:/Users/x/plugin-data/browser-agent/profile-chrome',
    )).toBe(true)
  })

  it('launches chrome then edge then chrome with orphan kill between', async () => {
    mkdirSync(profileRoot, { recursive: true })

    for (const kind of ['chrome', 'edge', 'chrome'] as const) {
      const profileDir = browserAgentProfileDirFor(profileRoot, kind)
      const driver = new PlaywrightDriver({
        profileDir,
        preference: kind,
        profileRoot,
        headless: true,
      })
      await driver.ensureReady()
      expect(driver.status().endpoint).toBe(
        kind === 'edge' ? 'playwright:msedge' : 'playwright:chrome',
      )
      // Hold the profile lock like a headed orphan, then kill via product path.
      stopAgentBrowserProcesses(profileDir)
      await new Promise(r => setTimeout(r, 400))
      expect(countProfileProcs(profileDir)).toBe(0)
      await driver.dispose().catch(() => undefined)
    }
  }, 120_000)
})
