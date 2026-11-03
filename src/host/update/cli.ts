import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { PACKAGE_NAME } from '../../identity.ts'
import type { InstallKind } from './types.ts'

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess

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

async function runDsh(
  args: readonly string[],
  spawnFn: SpawnLike,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  let child: ChildProcess
  try {
    child = spawnFn('dsh', args, dshSpawnOptions())
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
  return waitForExit(child, timeoutMs)
}

export async function probeDsh(spawnFn: SpawnLike = defaultSpawn): Promise<boolean> {
  const result = await runDsh(['--version'], spawnFn, PROBE_TIMEOUT_MS)
  return result.ok
}

export async function runPluginAdd(
  latest: string,
  spawnFn: SpawnLike = defaultSpawn,
): Promise<{ ok: boolean; detail: string }> {
  if (!isStrictVersion(latest)) return { ok: false, detail: 'invalid version' }
  return runDsh(pluginAddArgs(latest), spawnFn, RUN_ADD_TIMEOUT_MS)
}
