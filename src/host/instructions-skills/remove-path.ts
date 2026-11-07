/**
 * Fast Windows-tolerant delete for managed skill installs.
 * Avoid long retry / attrib / cmd loops — those freeze the uninstall UI even
 * after the skill is already gone (delete-pending phantom paths).
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { AuxiliaryError } from '../../errors.ts'

function pathPresent(path: string): boolean {
  try {
    lstatSync(path)
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

/**
 * Delete `target` quickly. Throws only when a usable skill tree still remains.
 */
export function removePathRobust(target: string): void {
  const absolute = resolve(target)
  if (effectivelyGone(absolute)) return

  // Junction / symlink: unlink the link only (do not walk the target).
  try {
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) {
      try {
        unlinkSync(absolute)
      } catch {
        // fall through
      }
      if (effectivelyGone(absolute)) return
    }
  } catch {
    if (effectivelyGone(absolute)) return
  }

  try {
    rmSync(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 })
  } catch {
    // continue
  }
  if (effectivelyGone(absolute)) return

  // Free the install name even if Windows holds a delete-pending handle.
  const aside = `${absolute}.__ae_removing_${process.pid}_${Date.now()}`
  try {
    renameSync(absolute, aside)
    try {
      rmSync(aside, { recursive: true, force: true, maxRetries: 2, retryDelay: 40 })
    } catch {
      // Name is free; aside can linger briefly.
    }
    return
  } catch {
    // EPERM rename — fall through
  }

  if (effectivelyGone(absolute)) return

  throw new AuxiliaryError(
    'FILE_EDIT_FAILED',
    `Failed to remove ${basename(absolute)}: still present (EPERM / file in use — close skill preview or Desktop file tabs, then retry)`,
  )
}
