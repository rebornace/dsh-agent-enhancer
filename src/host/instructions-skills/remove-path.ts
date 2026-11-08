/**
 * Fast Windows-tolerant delete for managed skill installs.
 * Avoid long retry / attrib / cmd loops — those freeze the uninstall UI even
 * after the skill is already gone (delete-pending phantom paths).
 *
 * Junctions / reparse points must be unlinked (not recursively walked) so we
 * never delete into Cursor / skills-manager targets.
 * Never run `rmdir /s` on a reparse point — classic Windows footgun that can
 * wipe the junction target (skills-manager central store).
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { AuxiliaryError } from '../../errors.ts'
import { busyPathHint, isWindowsPathBusyError } from './fs-access.ts'
import { agentsHomeOf, dshHomeOf, isInsideOrSame, samePath } from './paths.ts'
import { removeQuietly, renameAsideToTemp } from './transient-paths.ts'

function pathPresent(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Lexical DSH install/uninstall roots — never treat these as "external protected". */
function isManagedSkillEntryPath(target: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const absolute = resolve(target)
  const managedRoots = [
    join(agentsHomeOf(env), 'skills'),
    join(dshHomeOf(env), 'skills'),
  ]
  for (const root of managedRoots) {
    if (samePath(absolute, root) || isInsideOrSame(root, absolute)) return true
  }
  return false
}

/**
 * Paths under third-party skill stores must never be deleted by DSH install /
 * uninstall — skills-manager keeps its central copy + DB source_ref there.
 *
 * Managed `~/.agents/skills/<name>` entries are excluded even when they are
 * junctions into skills-manager (we only unlink the mount point).
 */
export function isProtectedExternalSkillPath(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const absolute = resolve(target)
  if (isManagedSkillEntryPath(absolute, env)) return false
  const home = resolve(homedir())
  const protectedRoots = [
    join(home, '.skills-manager'),
    join(home, '.cursor', 'skills'),
    join(home, '.cursor', 'skills-cursor'),
    join(home, '.codex', 'skills'),
    join(home, '.claude', 'skills'),
    join(home, '.codebuddy', 'skills'),
    join(home, '.workbuddy', 'skills'),
  ]
  for (const root of protectedRoots) {
    if (samePath(absolute, root) || isInsideOrSame(root, absolute)) return true
  }
  return false
}

/**
 * True for symlinks and Windows directory junctions (reparse points).
 * Prefer unlinking these so recursive delete never walks the target.
 */
export function isReparseOrSymlink(path: string): boolean {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return true
    // Non-dir special nodes (sockets etc.) — treat as unlink-only.
    if (!stat.isDirectory() && !stat.isFile()) return true
  } catch {
    return false
  }
  if (process.platform !== 'win32') return false
  // Some Windows reparse points report as directories; readlink still works.
  try {
    readlinkSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Windows often keeps a delete-pending directory visible after a successful
 * rm. Treat the skill as gone when SKILL.md is absent and the tree is empty
 * or unreadable.
 */
function effectivelyGone(target: string): boolean {
  if (!pathPresent(target) && !existsSync(target)) return true
  try {
    const stat = lstatSync(target)
    if (stat.isSymbolicLink()) return false
    if (!stat.isDirectory()) return false
    if (existsSync(join(target, 'SKILL.md'))) return false
    let names: string[]
    try {
      names = readdirSync(target)
    } catch {
      // Unreadable delete-pending dir — treat as gone.
      return true
    }
    return names.length === 0
  } catch {
    return true
  }
}

/** Unlink a junction / symlink / file without walking any target. */
function unlinkMountOnly(absolute: string): boolean {
  try {
    unlinkSync(absolute)
  } catch {
    if (process.platform === 'win32') {
      // `rmdir` without /s removes an empty junction mount, not the target tree.
      try {
        execFileSync('cmd', ['/d', '/s', '/c', `rmdir "${absolute.replace(/"/g, '')}"`], {
          windowsHide: true,
          timeout: 15_000,
          stdio: 'ignore',
        })
      } catch {
        return false
      }
    } else {
      return false
    }
  }
  return !pathPresent(absolute) && !existsSync(absolute)
}

function tryUnlinkReparseOrFile(absolute: string): boolean {
  let preferUnlink = false
  try {
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink() || stat.isFile()) preferUnlink = true
    else if (!stat.isDirectory()) preferUnlink = true
    else if (isReparseOrSymlink(absolute)) preferUnlink = true
  } catch {
    if (effectivelyGone(absolute)) return true
  }
  if (!preferUnlink) return false
  return unlinkMountOnly(absolute)
}

/**
 * Delete `target` quickly. Throws only when a usable skill tree still remains.
 * External stores (skills-manager / Cursor / …) are skipped, not denied — a
 * post-install purge must not abort a successful ~/.agents write with FILE_DENIED.
 */
export function removePathRobust(target: string): void {
  const absolute = resolve(target)
  if (isProtectedExternalSkillPath(absolute)) {
    // Skip only — never FILE_DENIED (UI maps that to「没有权限访问该路径」).
    return
  }
  // Only skip when the path is truly absent. Empty shells without SKILL.md are
  // "effectively gone" as skill content, but must still be deleted so install
  // can reuse the name.
  if (!pathPresent(absolute) && !existsSync(absolute)) return

  // Junction / symlink first — never fall through to recursive rm / rmdir /s.
  if (isReparseOrSymlink(absolute)) {
    if (unlinkMountOnly(absolute)) return
    if (effectivelyGone(absolute)) return
    throw new AuxiliaryError('FILE_EDIT_FAILED', busyPathHint(basename(absolute)))
  }

  if (tryUnlinkReparseOrFile(absolute)) return

  if (process.platform === 'win32') {
    try {
      chmodSync(absolute, 0o666)
    } catch {
      // best-effort clear read-only on the entry itself
    }
  }

  try {
    rmSync(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 })
  } catch (error) {
    if (!isWindowsPathBusyError(error) && effectivelyGone(absolute)) return
    // continue to rename / cmd fallback
  }
  if (!pathPresent(absolute) && !existsSync(absolute)) return

  // Free the install name by moving aside into OS temp (not under skills/).
  try {
    const aside = renameAsideToTemp(absolute, 'removing')
    removeQuietly(aside)
    return
  } catch {
    // EPERM / EIO rename — fall through
  }

  if (process.platform === 'win32') {
    // Real directories only — never use /s on a reparse point (checked above).
    if (isReparseOrSymlink(absolute)) {
      if (unlinkMountOnly(absolute)) return
    } else {
      try {
        execFileSync('cmd', ['/d', '/s', '/c', `rmdir /s /q "${absolute.replace(/"/g, '')}"`], {
          windowsHide: true,
          timeout: 30_000,
          stdio: 'ignore',
        })
      } catch {
        // fall through
      }
    }
    if (!pathPresent(absolute) && !existsSync(absolute)) return
    if (effectivelyGone(absolute)) return
  }

  if (effectivelyGone(absolute) || (!pathPresent(absolute) && !existsSync(absolute))) return

  throw new AuxiliaryError('FILE_EDIT_FAILED', busyPathHint(basename(absolute)))
}
