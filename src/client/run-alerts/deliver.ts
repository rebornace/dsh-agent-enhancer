import { agentEnhancerShowOsNotification } from '../remote.ts'

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported'

export function notificationPermission(): NotificationPermissionState {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

export async function ensureNotificationPermission(): Promise<NotificationPermissionState> {
  const current = notificationPermission()
  if (current !== 'default') return current
  try {
    const result = await Notification.requestPermission()
    if (result === 'granted' || result === 'denied' || result === 'default') return result
    return 'denied'
  } catch {
    return 'denied'
  }
}

export interface SystemNotificationInput {
  readonly title: string
  readonly body: string
  readonly tag?: string
  /** Host remote for Electron / Windows Action Center notifications. */
  readonly remote?: unknown
}

async function showWebNotification(input: SystemNotificationInput): Promise<boolean> {
  const permission = await ensureNotificationPermission()
  if (permission !== 'granted') return false
  try {
    const note = new Notification(input.title, {
      body: input.body,
      tag: input.tag,
      silent: false,
    })
    note.onclick = () => {
      try {
        window.focus()
      } catch {
        // Focus is best-effort in Desktop webviews.
      }
      try {
        note.close()
      } catch {
        // ignore
      }
    }
    return true
  } catch {
    return false
  }
}

/**
 * Prefer host Electron / Windows toast (shows in Action Center), then Web Notification.
 * @returns false when the caller should fall back to Toast.
 */
export async function showSystemNotification(input: SystemNotificationInput): Promise<boolean> {
  if (input.remote !== undefined && input.remote !== null) {
    const host = await agentEnhancerShowOsNotification.invoke(input.remote, {
      title: input.title,
      body: input.body,
      ...(input.tag === undefined ? {} : { tag: input.tag }),
    })
    if (host.shown) return true
  }
  return await showWebNotification(input)
}
