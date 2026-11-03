import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_NAME } from '../../identity.ts'
import type { InstallKind } from './types.ts'

export function detectInstallKind(profileDir: string): InstallKind {
  const pkgPath = join(profileDir, 'node_modules', PACKAGE_NAME)
  try {
    const stat = lstatSync(pkgPath)
    if (stat.isSymbolicLink()) return 'link'
    if (stat.isDirectory()) return 'npm'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
