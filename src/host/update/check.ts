import { homedir } from 'node:os'
import { join } from 'node:path'
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../identity.ts'
import { pluginAddCommand, probeDsh, resolveCanAutoApply, runPluginAdd } from './cli.ts'
import { detectInstallKind } from './install-kind.ts'
import { fetchLatestVersion } from './registry.ts'
import { isNewerVersion } from './semver.ts'
import type {
  ApplyUpdateCode,
  ApplyUpdateResult,
  InstallKind,
  UpdateCheckResult,
} from './types.ts'

export function resolveDesktopProfileDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const dshHome = env.DSH_HOME ?? join(home, '.dsh')
  return join(dshHome, 'profiles', 'desktop')
}

export interface CheckPluginUpdateDeps {
  readonly currentVersion: string
  readonly fetchLatest: () => Promise<string | null>
  readonly detectKind: (profileDir: string) => InstallKind
  readonly dshAvailable: () => Promise<boolean>
  readonly profileDir: string
}

export async function checkPluginUpdate(deps: CheckPluginUpdateDeps): Promise<UpdateCheckResult> {
  const latest = await deps.fetchLatest()
  const installKind = deps.detectKind(deps.profileDir)
  const dshAvailable = await deps.dshAvailable().catch(() => false)
  const updateAvailable =
    latest !== null && isNewerVersion(latest, deps.currentVersion)
  const command = pluginAddCommand(latest ?? 'latest')
  const canAutoApply = resolveCanAutoApply({ installKind, dshAvailable })

  return {
    current: deps.currentVersion,
    latest,
    updateAvailable,
    installKind,
    canAutoApply,
    command,
  }
}

export interface ApplyUpdateMessages {
  readonly linkBlocked: ApplyUpdateCode
  readonly success: ApplyUpdateCode
  readonly failed: ApplyUpdateCode
  readonly noUpdate: ApplyUpdateCode
  readonly manualOnly?: ApplyUpdateCode
}

export interface ApplyPluginUpdateInput {
  readonly check: UpdateCheckResult
  readonly runAdd: (latest: string) => Promise<{ ok: boolean; detail: string }>
  readonly messages: ApplyUpdateMessages
}

export async function applyPluginUpdate(
  input: ApplyPluginUpdateInput,
): Promise<ApplyUpdateResult> {
  const { check, runAdd, messages } = input

  if (check.latest === null || !check.updateAvailable) {
    return { ok: false, message: messages.noUpdate, command: check.command }
  }

  if (!check.canAutoApply) {
    const message =
      check.installKind === 'link'
        ? messages.linkBlocked
        : (messages.manualOnly ?? messages.failed)
    return { ok: false, message, command: check.command }
  }

  const result = await runAdd(check.latest)
  if (!result.ok) {
    return { ok: false, message: messages.failed, command: check.command }
  }

  return { ok: true, message: messages.success }
}

function defaultCheckDeps(overrides: Partial<CheckPluginUpdateDeps> = {}): CheckPluginUpdateDeps {
  const profileDir = overrides.profileDir ?? resolveDesktopProfileDir()
  return {
    currentVersion: PACKAGE_VERSION,
    fetchLatest: () => fetchLatestVersion(PACKAGE_NAME),
    detectKind: (dir) => detectInstallKind(dir),
    dshAvailable: () => probeDsh(),
    profileDir,
    ...overrides,
  }
}

/** Host entry: check with registry, profile layout, and dsh probe. */
export async function checkPluginUpdateForHost(
  overrides?: Partial<CheckPluginUpdateDeps>,
): Promise<UpdateCheckResult> {
  return checkPluginUpdate(defaultCheckDeps(overrides))
}

/** Host entry: re-check then apply via `dsh plugin add`. */
export async function applyPluginUpdateForHost(
  messages: ApplyUpdateMessages,
  overrides?: Partial<CheckPluginUpdateDeps>,
): Promise<ApplyUpdateResult> {
  const check = await checkPluginUpdate(defaultCheckDeps(overrides))
  return applyPluginUpdate({
    check,
    runAdd: (latest) => runPluginAdd(latest),
    messages,
  })
}

export default checkPluginUpdateForHost
