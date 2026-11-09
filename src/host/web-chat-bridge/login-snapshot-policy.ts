import type { WebChatLoginSnapshot } from './login-snapshot-types.ts'

export type WebChatLoginCaptureSlice = Pick<WebChatLoginSnapshot, 'localStorage' | 'cookie'>

function localStorageKeyCount(slice: WebChatLoginCaptureSlice): number {
  return Object.keys(slice.localStorage).length
}

function hasCookie(slice: WebChatLoginCaptureSlice): boolean {
  return slice.cookie.trim().length > 0
}

/** True when a guest capture is worth writing over `baseline` (disk or last good). */
export function shouldPersistWebChatLoginCapture(
  baseline: WebChatLoginSnapshot | null,
  candidate: WebChatLoginCaptureSlice | null,
): boolean {
  if (candidate === null) return false
  const candidateKeys = localStorageKeyCount(candidate)
  const candidateCookie = hasCookie(candidate)
  if (candidateKeys === 0 && !candidateCookie) return false
  if (baseline === null) return true
  const baselineKeys = localStorageKeyCount(baseline)
  const baselineCookie = hasCookie(baseline)
  if (baselineKeys > 0 && candidateKeys === 0) return false
  if (baselineCookie && !candidateCookie && candidateKeys === 0) return false
  return true
}
