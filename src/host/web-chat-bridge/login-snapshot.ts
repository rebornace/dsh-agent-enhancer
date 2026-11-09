import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  WEB_CHAT_LOGIN_SNAPSHOT_VERSION,
  WEB_CHAT_OFFICIAL_ORIGIN,
  type WebChatLoginSnapshot,
} from './login-snapshot-types.ts'
import { shouldPersistWebChatLoginCapture } from './login-snapshot-policy.ts'

export {
  WEB_CHAT_LOGIN_SNAPSHOT_VERSION,
  WEB_CHAT_OFFICIAL_ORIGIN,
  type WebChatLoginSnapshot,
} from './login-snapshot-types.ts'

const SENSITIVE_STORAGE_KEY = /password|passwd|pwd/i

export function webChatBridgeDataDir(pluginDataPackageRoot: string): string {
  return join(pluginDataPackageRoot, 'web-chat-bridge')
}

export function webChatLoginSnapshotPath(pluginDataPackageRoot: string): string {
  return join(webChatBridgeDataDir(pluginDataPackageRoot), 'session.json')
}

export function sanitizeLocalStorage(
  entries: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(entries)) {
    if (typeof key !== 'string' || typeof value !== 'string') continue
    if (SENSITIVE_STORAGE_KEY.test(key)) continue
    out[key] = value
  }
  return out
}

function parseSnapshot(raw: string): WebChatLoginSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as Partial<WebChatLoginSnapshot>
    if (parsed.version !== WEB_CHAT_LOGIN_SNAPSHOT_VERSION) return null
    if (parsed.origin !== WEB_CHAT_OFFICIAL_ORIGIN) return null
    const localStorage = sanitizeLocalStorage(
      typeof parsed.localStorage === 'object' && parsed.localStorage !== null
        ? parsed.localStorage as Record<string, string>
        : {},
    )
    const cookie = typeof parsed.cookie === 'string' ? parsed.cookie : ''
    const savedAt = typeof parsed.savedAt === 'string' && parsed.savedAt.trim() !== ''
      ? parsed.savedAt
      : new Date().toISOString()
    return {
      version: WEB_CHAT_LOGIN_SNAPSHOT_VERSION,
      origin: WEB_CHAT_OFFICIAL_ORIGIN,
      localStorage,
      cookie,
      savedAt,
    }
  } catch {
    return null
  }
}

export function loadWebChatLoginSnapshot(pluginDataPackageRoot: string): WebChatLoginSnapshot | null {
  const path = webChatLoginSnapshotPath(pluginDataPackageRoot)
  if (!existsSync(path)) return null
  try {
    return parseSnapshot(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function saveWebChatLoginSnapshot(
  pluginDataPackageRoot: string,
  input: Omit<WebChatLoginSnapshot, 'version' | 'origin'> & {
    readonly origin?: string
  },
  options?: { readonly baseline?: WebChatLoginSnapshot | null },
): WebChatLoginSnapshot | null {
  const baseline = options?.baseline !== undefined
    ? options.baseline
    : loadWebChatLoginSnapshot(pluginDataPackageRoot)
  const candidate = {
    localStorage: input.localStorage,
    cookie: input.cookie,
  }
  if (!shouldPersistWebChatLoginCapture(baseline, candidate)) {
    return baseline
  }
  if (input.origin !== undefined && input.origin !== WEB_CHAT_OFFICIAL_ORIGIN) {
    throw new Error('Web chat login snapshot origin mismatch')
  }
  const snapshot: WebChatLoginSnapshot = {
    version: WEB_CHAT_LOGIN_SNAPSHOT_VERSION,
    origin: WEB_CHAT_OFFICIAL_ORIGIN,
    localStorage: sanitizeLocalStorage(input.localStorage),
    cookie: typeof input.cookie === 'string' ? input.cookie : '',
    savedAt: typeof input.savedAt === 'string' && input.savedAt.trim() !== ''
      ? input.savedAt
      : new Date().toISOString(),
  }
  const path = webChatLoginSnapshotPath(pluginDataPackageRoot)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
  return snapshot
}

export { shouldPersistWebChatLoginCapture } from './login-snapshot-policy.ts'

export function clearWebChatLoginSnapshot(pluginDataPackageRoot: string): boolean {
  const path = webChatLoginSnapshotPath(pluginDataPackageRoot)
  if (!existsSync(path)) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}
