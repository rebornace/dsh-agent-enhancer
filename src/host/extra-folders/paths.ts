import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Stable filename key for a primary workspace cwd. */
export function cwdStorageKey(primaryCwd: string): string {
  const normalized = resolve(primaryCwd)
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32)
}

/** True when `absolutePath` is the root itself or a descendant. */
export function isInsideRoot(root: string, absolutePath: string): boolean {
  const base = resolve(root)
  const target = resolve(absolutePath)
  const rel = relative(base, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Throw when the path is outside every allowed root. */
export function assertInsideAllowedRoots(
  primaryCwd: string,
  extraRoots: readonly string[],
  absolutePath: string,
): void {
  if (isInsideRoot(primaryCwd, absolutePath)) return
  for (const root of extraRoots) {
    if (isInsideRoot(root, absolutePath)) return
  }
  throw new Error('Path is outside the session workspace and attached folders')
}

export function normalizeRootPath(path: string): string {
  const trimmed = path.trim()
  if (trimmed === '') throw new Error('Path is empty')
  return resolve(trimmed)
}
