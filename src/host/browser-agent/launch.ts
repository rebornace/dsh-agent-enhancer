import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type BrowserKind = 'chrome' | 'edge' | 'safari'
export type BrowserPreference = 'auto' | BrowserKind
/** Playwright launch channel tokens used in driver status endpoints. */
export type PlaywrightChannel = 'chrome' | 'msedge' | 'webkit'

export interface ResolvedBrowser {
  readonly kind: BrowserKind
  readonly executable: string
}

/** Profile directory slots that may hold a headed Playwright window. */
export const BROWSER_AGENT_PROFILE_SLOTS = [
  'auto',
  'auto-chrome',
  'auto-msedge',
  'auto-webkit',
  'chrome',
  'edge',
  'safari',
] as const
export type BrowserAgentProfileSlot = typeof BROWSER_AGENT_PROFILE_SLOTS[number]

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

function uniquePaths(paths: readonly string[]): string[] {
  const out: string[] = []
  for (const path of paths) {
    if (path.trim() === '' || out.includes(path)) continue
    out.push(path)
  }
  return out
}

function darwinAppExecutable(appName: string, binaryName: string, home: string): string[] {
  const relative = join(`${appName}.app`, 'Contents', 'MacOS', binaryName)
  return [
    join('/Applications', relative),
    join(home, 'Applications', relative),
  ]
}

/** Candidate chrome.exe / msedge.exe paths for the current platform. */
export function browserExecutableCandidates(
  kind: BrowserKind,
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir()

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
    if (kind === 'safari') return []
    return [
      ...roots.map(root => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]
  }

  if (platform === 'darwin') {
    // Homebrew Cask usually links into /Applications; also cover ~/Applications.
    // Mac agent browsers: Chrome + system Safari (automation via Playwright WebKit).
    if (kind === 'chrome') {
      return uniquePaths([
        ...darwinAppExecutable('Google Chrome', 'Google Chrome', home),
        ...darwinAppExecutable('Google Chrome Canary', 'Google Chrome Canary', home),
        ...darwinAppExecutable('Chromium', 'Chromium', home),
      ])
    }
    if (kind === 'safari') {
      return uniquePaths([
        ...darwinAppExecutable('Safari', 'Safari', home),
      ])
    }
    // Edge is not offered on Mac menus; keep paths for cross-platform resolve tests.
    return uniquePaths([
      ...darwinAppExecutable('Microsoft Edge', 'Microsoft Edge', home),
      ...darwinAppExecutable('Microsoft Edge Beta', 'Microsoft Edge Beta', home),
      ...darwinAppExecutable('Microsoft Edge Dev', 'Microsoft Edge Dev', home),
    ])
  }

  if (kind === 'chrome') {
    return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  }
  if (kind === 'safari') {
    return []
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
    ? (kind === 'chrome'
      ? ['chrome.exe', 'chrome']
      : kind === 'edge'
        ? ['msedge.exe', 'msedge']
        : [])
    : (kind === 'chrome'
      ? ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
      : kind === 'edge'
        ? ['microsoft-edge', 'microsoft-edge-stable', 'msedge']
        : [])
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
  // Win → Edge, Mac → Safari, else Chrome.
  const order: readonly BrowserKind[] = preference === 'auto'
    ? (platform === 'win32'
      ? ['edge', 'chrome']
      : platform === 'darwin'
        ? ['safari', 'chrome']
        : ['chrome'])
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

/** Absolute profile directory for a known slot name. */
export function browserAgentProfileSlotDir(
  pluginDataPackageRoot: string,
  slot: BrowserAgentProfileSlot,
): string {
  return join(pluginDataPackageRoot, 'browser-agent', `profile-${slot}`)
}

/**
 * Separate persistent profiles per browser preference / auto channel.
 * Sharing one dir across Chromium↔WebKit (or Edge↔Chrome) makes the second
 * launch fail or flap open/close — auto must isolate by channel.
 */
export function browserAgentProfileDirFor(
  pluginDataPackageRoot: string,
  preference: BrowserPreference,
  channel?: PlaywrightChannel,
): string {
  if (preference === 'chrome' || preference === 'edge' || preference === 'safari') {
    return browserAgentProfileSlotDir(pluginDataPackageRoot, preference)
  }
  if (channel === 'chrome' || channel === 'msedge' || channel === 'webkit') {
    return browserAgentProfileSlotDir(pluginDataPackageRoot, `auto-${channel}`)
  }
  return browserAgentProfileSlotDir(pluginDataPackageRoot, 'auto')
}

/**
 * Channel try-order for Playwright.
 * Explicit chrome / edge / safari never falls back.
 * Auto: Windows → Edge then Chrome; Mac → WebKit(Safari) then Chrome.
 */
export function playwrightChannelOrder(
  preference: BrowserPreference,
  platform: NodeJS.Platform = process.platform,
): readonly PlaywrightChannel[] {
  if (preference === 'chrome') return ['chrome']
  if (preference === 'edge') return ['msedge']
  if (preference === 'safari') return ['webkit']
  if (platform === 'win32') return ['msedge', 'chrome']
  if (platform === 'darwin') return ['webkit', 'chrome']
  return ['chrome']
}

/**
 * True when a running Playwright channel still satisfies the settings preference.
 * Critical for `auto`: a Chrome fallback must not be torn down every tick just
 * because WebKit is listed first.
 */
export function playwrightChannelSatisfiesPreference(
  channel: PlaywrightChannel | null | undefined,
  preference: BrowserPreference,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (channel === null || channel === undefined) return false
  return playwrightChannelOrder(preference, platform).includes(channel)
}

/** Map a Playwright channel token back to the UI/browser kind. */
export function browserKindFromPlaywrightChannel(
  channel: PlaywrightChannel,
): Exclude<BrowserKind, never> {
  switch (channel) {
    case 'chrome':
      return 'chrome'
    case 'msedge':
      return 'edge'
    case 'webkit':
      return 'safari'
    default: {
      const _exhaustive: never = channel
      return _exhaustive
    }
  }
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
