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

function dshCommand(): string {
  return process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
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
  const command = dshCommand()
  const child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
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
  return runDsh(pluginAddArgs(latest), spawnFn, RUN_ADD_TIMEOUT_MS)
}
