import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix as pathPosix } from 'node:path'
import { PACKAGE_NAME } from '../../identity.ts'
import type { InstallKind } from './types.ts'

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess

export interface DshResolveOptions {
  readonly platform?: NodeJS.Platform
  readonly home?: string
  readonly execPath?: string
  readonly env?: NodeJS.ProcessEnv
}

export interface DshRunOptions {
  /** Override candidate command list (tests). */
  readonly candidates?: readonly string[]
  /** Override existence checks for absolute candidates (tests). */
  readonly exists?: (path: string) => boolean
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
): ChildProcess {
  return nodeSpawn(command, [...args], options ?? {})
}

const PROBE_TIMEOUT_MS = 5_000
const RUN_ADD_TIMEOUT_MS = 120_000

/** Strict x.y.z only; the version is interpolated into a shell command line on win32. */
const STRICT_SEMVER = /^\d+\.\d+\.\d+$/

export function isStrictVersion(value: string): boolean {
  return STRICT_SEMVER.test(value)
}

/**
 * Map Electron `process.execPath` inside DeepSeek Harness.app to the bundled CLI.
 * Example:
 *   …/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness
 * → …/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh
 */
export function dshFromElectronExecPath(execPath: string): string | null {
  const normalized = execPath.replace(/\\/g, '/')
  const marker = '/Contents/MacOS/'
  const idx = normalized.lastIndexOf(marker)
  if (idx < 0) return null
  const contentsRoot = normalized.slice(0, idx + '/Contents'.length)
  // Keep POSIX separators: Mac App paths must not pick up win32 `\` in CI/tests.
  return pathPosix.join(contentsRoot, 'Resources', 'runtime', 'cli', 'bin', 'dsh')
}

/**
 * Candidate `dsh` executables. Absolute Mac App paths first when present in the
 * list; callers skip missing files. Bare `dsh` is always last for PATH lookup.
 */
export function dshExecutableCandidates(options: DshResolveOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? env.HOME?.trim() ?? homedir()
  const execPath = options.execPath ?? process.execPath
  const out: string[] = []
  const push = (value: string | null | undefined): void => {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed === '' || out.includes(trimmed)) return
    out.push(trimmed)
  }

  push(env.DSH_CLI)

  if (platform === 'darwin') {
    push(dshFromElectronExecPath(execPath))
    push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh')
    push(pathPosix.join(
      home,
      'Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
    ))
  }

  push('dsh')
  return out
}

/** True when spawn failed because the binary is missing (try next candidate). */
export function isCommandMissingDetail(detail: string): boolean {
  return /ENOENT|not found|spawn .*(ENOENT|not found)/i.test(detail)
}

/**
 * Node >= 22 refuses to spawn `.cmd` files without a shell (sync EINVAL), so on
 * win32 we spawn `dsh` through the shell (cmd resolves dsh.cmd via PATHEXT).
 */
function dshSpawnOptions(): SpawnOptions {
  const base: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'] }
  return process.platform === 'win32' ? { ...base, shell: true, windowsHide: true } : base
}

function pluginAddArgs(latest: string): string[] {
  return ['plugin', '--profile', 'desktop', 'add', `${PACKAGE_NAME}@${latest}`]
}

export function pluginAddCommand(latest: string): string {
  return `dsh plugin --profile desktop add ${PACKAGE_NAME}@${latest}`
}

export function resolveCanAutoApply(input: {
  readonly installKind: InstallKind
  readonly dshAvailable: boolean
}): boolean {
  return input.installKind === 'npm' && input.dshAvailable
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let settled = false
    const chunks: Buffer[] = []
    const finish = (ok: boolean, detail: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, detail })
    }

    const timer = setTimeout(() => {
      child.kill()
      finish(false, 'timeout')
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk))

    child.on('error', (err) => {
      finish(false, err.message)
    })

    child.on('close', (code) => {
      const detail = Buffer.concat(chunks).toString('utf8').trim()
      finish(code === 0, detail)
    })
  })
}

async function runDshOnce(
  command: string,
  args: readonly string[],
  spawnFn: SpawnLike,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  let child: ChildProcess
  try {
    child = spawnFn(command, args, dshSpawnOptions())
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
  return waitForExit(child, timeoutMs)
}

async function runDsh(
  args: readonly string[],
  spawnFn: SpawnLike,
  timeoutMs: number,
  options: DshRunOptions = {},
): Promise<{ ok: boolean; detail: string }> {
  const candidates = options.candidates ?? dshExecutableCandidates()
  const exists = options.exists ?? existsSync
  let last: { ok: boolean; detail: string } = { ok: false, detail: 'dsh not found' }

  for (const command of candidates) {
    // Bare PATH name must always be attempted; absolute paths only if present.
    if (command !== 'dsh' && !exists(command)) continue
    const result = await runDshOnce(command, args, spawnFn, timeoutMs)
    if (result.ok) return result
    last = result
    // Missing binary → try next candidate. Real CLI errors should surface.
    if (!isCommandMissingDetail(result.detail)) return result
  }

  return last
}

export async function probeDsh(
  spawnFn: SpawnLike = defaultSpawn,
  options: DshRunOptions = {},
): Promise<boolean> {
  const result = await runDsh(['--version'], spawnFn, PROBE_TIMEOUT_MS, options)
  return result.ok
}

export async function runPluginAdd(
  latest: string,
  spawnFn: SpawnLike = defaultSpawn,
  options: DshRunOptions = {},
): Promise<{ ok: boolean; detail: string }> {
  if (!isStrictVersion(latest)) return { ok: false, detail: 'invalid version' }
  return runDsh(pluginAddArgs(latest), spawnFn, RUN_ADD_TIMEOUT_MS, options)
}
