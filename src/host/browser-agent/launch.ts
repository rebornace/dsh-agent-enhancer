import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type BrowserKind = 'chrome' | 'edge'
export type BrowserPreference = 'auto' | BrowserKind

export interface ResolvedBrowser {
  readonly kind: BrowserKind
  readonly executable: string
}

/** Read Windows env with both PROCESSOR-preserved and upper-case keys. */
export function windowsEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const variants = [
    name,
    name.toUpperCase(),
    name.toLowerCase(),
    // Common mixed-case forms used by Windows / Electron.
    name === 'ProgramFiles' ? 'PROGRAMFILES' : null,
    name === 'ProgramFiles(x86)' ? 'PROGRAMFILES(X86)' : null,
    name === 'ProgramW6432' ? 'PROGRAMW6432' : null,
    name === 'LocalAppData' ? 'LOCALAPPDATA' : null,
  ]
  for (const key of variants) {
    if (key === null) continue
    const value = env[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Candidate chrome.exe / msedge.exe paths for the current platform. */
export function browserExecutableCandidates(
  kind: BrowserKind,
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const home = homedir()

  if (platform === 'win32') {
    const local = windowsEnv('LocalAppData', env)
    // WoW64 hosts often have PROGRAMFILES → x86; real 64-bit dir is ProgramW6432.
    const programFiles64 = windowsEnv('ProgramW6432', env) ?? 'C:\\Program Files'
    const programFiles = windowsEnv('ProgramFiles', env) ?? programFiles64
    const programFilesX86 = windowsEnv('ProgramFiles(x86)', env) ?? 'C:\\Program Files (x86)'
    const roots = [...new Set([local, programFiles64, programFiles, programFilesX86].filter(
      (path): path is string => typeof path === 'string' && path !== '',
    ))]

    if (kind === 'chrome') {
      return [
        ...roots.map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
        // Hardcoded fallbacks when env is stripped in Electron.
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    }
    return [
      ...roots.map(root => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]
  }

  if (platform === 'darwin') {
    if (kind === 'chrome') {
      return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    }
    return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
  }

  if (kind === 'chrome') {
    return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  }
  return ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
}

function lookUpOnPath(
  kind: BrowserKind,
  platform: NodeJS.Platform,
  where: (command: string) => string | null,
  exists: (path: string) => boolean,
): string | null {
  const names = platform === 'win32'
    ? (kind === 'chrome' ? ['chrome.exe', 'chrome'] : ['msedge.exe', 'msedge'])
    : (kind === 'chrome'
      ? ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
      : ['microsoft-edge', 'microsoft-edge-stable', 'msedge'])
  for (const name of names) {
    const hit = where(name)
    if (hit !== null && exists(hit)) return hit
  }
  return null
}

function defaultWhere(command: string): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where.exe', [command], {
        encoding: 'utf8',
        timeout: 3_000,
        windowsHide: true,
      })
      const first = out.split(/\r?\n/).map(line => line.trim()).find(line => line !== '')
      return first ?? null
    }
    const out = execFileSync('which', [command], { encoding: 'utf8', timeout: 3_000 })
    const first = out.split(/\r?\n/).map(line => line.trim()).find(line => line !== '')
    return first ?? null
  } catch {
    return null
  }
}

export function resolveBrowserExecutable(
  preference: BrowserPreference = 'auto',
  options: {
    readonly exists?: (path: string) => boolean
    readonly platform?: NodeJS.Platform
    readonly env?: NodeJS.ProcessEnv
    readonly where?: (command: string) => string | null
  } = {},
): ResolvedBrowser | null {
  const exists = options.exists ?? existsSync
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  // Windows still prefers Edge — same channel Playwright uses by default.
  const order: readonly BrowserKind[] = preference === 'auto'
    ? (platform === 'win32' ? ['edge', 'chrome'] : ['chrome', 'edge'])
    : [preference]

  for (const kind of order) {
    const seen = new Set<string>()
    for (const executable of browserExecutableCandidates(kind, platform, env)) {
      if (seen.has(executable)) continue
      seen.add(executable)
      if (exists(executable)) return { kind, executable }
    }
    const fromPath = lookUpOnPath(kind, platform, options.where ?? defaultWhere, exists)
    if (fromPath !== null) return { kind, executable: fromPath }
  }
  return null
}

/** Legacy default slot (auto preference). Prefer {@link browserAgentProfileDirFor}. */
export function defaultBrowserAgentProfileDir(pluginDataPackageRoot: string): string {
  return browserAgentProfileDirFor(pluginDataPackageRoot, 'auto')
}

/**
 * Separate persistent profiles per browser preference.
 * Sharing one dir across Edge↔Chrome makes the second launch fail and silently fall back.
 */
export function browserAgentProfileDirFor(
  pluginDataPackageRoot: string,
  preference: BrowserPreference,
): string {
  const slot = preference === 'chrome' || preference === 'edge' ? preference : 'auto'
  return join(pluginDataPackageRoot, 'browser-agent', `profile-${slot}`)
}

/** Channel try-order for Playwright. Explicit chrome/edge never falls back. */
export function playwrightChannelOrder(
  preference: BrowserPreference,
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<'msedge' | 'chrome'> {
  if (preference === 'chrome') return ['chrome']
  if (preference === 'edge') return ['msedge']
  return platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'msedge']
}

/**
 * True when a process command line references this profile directory.
 * Windows Chromium uses backslashes in `--user-data-dir=...`; matching only
 * forward-slash needles never kills the old window (switch looked like a no-op).
 */
export function commandLineReferencesProfile(commandLine: string, profileDir: string): boolean {
  if (commandLine.trim() === '' || profileDir.trim() === '') return false
  const cmd = commandLine.replace(/\\/g, '/').toLowerCase()
  const needle = profileDir.replace(/\\/g, '/').toLowerCase()
  return cmd.includes(needle)
}

/**
 * Kill leftover agent browser processes that still hold `profileDir`.
 * Required before Playwright `launchPersistentContext` when a prior headed window
 * still locks the profile directory.
 */
export function stopAgentBrowserProcesses(profileDir: string): void {
  if (profileDir.trim() === '') return
  if (process.platform === 'win32') {
    try {
      // Normalize in PowerShell so IndexOf works against real Win32_Process CommandLine
      // values (backslashes) even when we pass a mixed-slash profile path.
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          [
            '$ErrorActionPreference = "SilentlyContinue"',
            '$needle = ($env:DSH_BA_PROFILE_DIR -replace "\\\\","/").ToLowerInvariant()',
            'Get-CimInstance Win32_Process |'
            + ' Where-Object {'
            + " ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and"
            + ' $_.CommandLine -and'
            + ' (($_.CommandLine -replace "\\\\","/").ToLowerInvariant().IndexOf($needle) -ge 0)'
            + ' } |'
            + ' ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
          ].join('; '),
        ],
        {
          timeout: 8_000,
          windowsHide: true,
          env: { ...process.env, DSH_BA_PROFILE_DIR: profileDir },
        },
      )
    } catch {
      // Best-effort — launch may still work if profile is not locked.
    }
    return
  }
  const needle = profileDir.replace(/\\/g, '/')
  try {
    execFileSync('pkill', ['-f', needle], { timeout: 5_000 })
  } catch {
    // ignore
  }
}
