/**
 * Windows often surfaces access-denied as EIO / EACCES with a localized
 * message (`拒绝访问`) that can arrive mojibake'd through RPC.
 */

const ACCESS_DENIED_RE = /eperm|eacces|eio|ebusy|access is denied|operation not permitted|file in use|still present|拒绝访问|¾Ü¾ø·ÃÎÊ/i

export function nodeErrno(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : null
}

export function isWindowsPathBusyError(error: unknown): boolean {
  const code = nodeErrno(error)
  if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EIO') return true
  const text = error instanceof Error ? error.message : String(error ?? '')
  return ACCESS_DENIED_RE.test(text)
}

export function busyPathHint(pathLabel: string): string {
  return (
    `Failed to update ${pathLabel}: still present (EPERM / EIO / file in use — `
    + 'close skill preview or Desktop file tabs, then retry)'
  )
}
