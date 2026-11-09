import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const nodeRequire = createRequire(import.meta.url)

/** Electron's default Windows AUMID for this Desktop product (`Get-StartApps`). */
export const DESKTOP_WINDOWS_APP_USER_MODEL_ID = 'electron.app.DeepSeek Harness'

export interface OsNotificationRequest {
  readonly title: string
  readonly body: string
  readonly tag?: string
}

export interface OsNotificationResult {
  readonly shown: boolean
  readonly channel: 'electron' | 'windows' | 'none'
}

interface ElectronAppLike {
  readonly getAppUserModelId?: () => string
  readonly getName?: () => string
  readonly name?: string
}

interface ElectronLike {
  readonly app?: ElectronAppLike
  readonly Notification?: {
    isSupported?: () => boolean
    new(options: {
      readonly title: string
      readonly body: string
      readonly silent?: boolean
      readonly timeoutType?: 'default' | 'never'
    }): { show(): void }
  }
}

function loadElectron(): ElectronLike | undefined {
  try {
    return nodeRequire('electron') as ElectronLike
  } catch {
    return undefined
  }
}

/**
 * Resolve the Windows toast AppUserModelID so Action Center attributes the
 * toast to DeepSeek Harness / DSH Desktop — never PowerShell.
 */
export function resolveWindowsAppId(
  electron: ElectronLike | undefined = loadElectron(),
): string {
  const fromEnv = process.env.DSH_TOAST_APP_ID?.trim()
  if (fromEnv) return fromEnv

  try {
    const id = electron?.app?.getAppUserModelId?.()
    if (typeof id === 'string' && id.trim() !== '') return id.trim()
  } catch {
    // ignore
  }

  try {
    const name = electron?.app?.getName?.() ?? electron?.app?.name
    if (typeof name === 'string' && name.trim() !== '') {
      return `electron.app.${name.trim()}`
    }
  } catch {
    // ignore
  }

  return DESKTOP_WINDOWS_APP_USER_MODEL_ID
}

function showViaElectron(
  input: OsNotificationRequest,
  electron: ElectronLike | undefined = loadElectron(),
): boolean {
  try {
    const NotificationCtor = electron?.Notification
    if (NotificationCtor === undefined) return false
    if (typeof NotificationCtor.isSupported === 'function' && !NotificationCtor.isSupported()) {
      return false
    }
    const note = new NotificationCtor({
      title: input.title,
      body: input.body,
      silent: false,
    })
    note.show()
    return true
  } catch {
    return false
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')
}

function escapePowerShellSingle(value: string): string {
  return value.replace(/'/gu, "''")
}

/**
 * Windows Action Center toast via PowerShell + WinRT, branded with Desktop AUMID.
 */
async function showViaWindowsToast(
  input: OsNotificationRequest,
  appId: string,
): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const title = escapeXml(input.title.slice(0, 120))
  const body = escapeXml(input.body.slice(0, 240))
  const xml = escapePowerShellSingle(
    `<toast><visual><binding template="ToastGeneric"><text>${title}</text><text>${body}</text></binding></visual></toast>`,
  )
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$xml = '${xml}'`,
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml($xml)',
    `$appId = '${escapePowerShellSingle(appId)}'`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)',
  ].join('; ')
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 8_000,
      env: process.env,
    })
    return true
  } catch {
    return false
  }
}

/** Prefer Electron native notification; on Windows fall back to WinRT under Desktop AUMID. */
export async function showOsNotificationNow(
  input: OsNotificationRequest,
): Promise<OsNotificationResult> {
  const title = input.title.trim()
  const body = input.body.trim()
  if (title === '' || body === '') return { shown: false, channel: 'none' }
  // Vitest loads this module in Node, where Electron Notification is missing and
  // the Windows fallback would post a real Action Center toast. Never do that.
  if (process.env.VITEST === 'true') return { shown: false, channel: 'none' }
  const payload = {
    title: title.slice(0, 120),
    body: body.slice(0, 240),
    ...(input.tag === undefined ? {} : { tag: input.tag }),
  }
  const electron = loadElectron()
  if (showViaElectron(payload, electron)) return { shown: true, channel: 'electron' }
  if (await showViaWindowsToast(payload, resolveWindowsAppId(electron))) {
    return { shown: true, channel: 'windows' }
  }
  return { shown: false, channel: 'none' }
}
