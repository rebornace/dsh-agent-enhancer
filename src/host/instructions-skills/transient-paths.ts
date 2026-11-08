/**
 * Install/uninstall may briefly rename or stage skill trees. Those must never
 * live as discoverable siblings under ~/.agents/skills (would look like extra skills).
 */
import { existsSync, lstatSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const TRANSIENT_MARK = /\.__ae_(?:removing|installing)_/

export function isTransientSkillEntryName(name: string): boolean {
  const base = basename(name.trim())
  if (base === '') return false
  return TRANSIENT_MARK.test(base) || base.startsWith('ae-skill-removing-') || base.startsWith('ae-skill-installing-')
}

/** Staging / aside dirs under the OS temp folder (not under skills roots). */
export function skillTransientWorkPath(kind: 'removing' | 'installing', skillName: string): string {
  const safe = skillName.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'skill'
  return join(tmpdir(), `ae-skill-${kind}-${safe}-${process.pid}-${Date.now()}`)
}

/**
 * Best-effort: delete leftover `*.__ae_removing_*` / `*.__ae_installing_*`
 * siblings under a skills root (from older builds that renamed in-place).
 */
export function sweepTransientSkillEntries(skillsRoot: string): void {
  const root = resolve(skillsRoot)
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    if (!isTransientSkillEntryName(name)) continue
    const full = join(root, name)
    try {
      rmSync(full, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 })
    } catch {
      // best-effort
    }
  }
}

/**
 * Rename `from` to a temp-dir aside. Falls back to same-parent sibling only when
 * cross-device rename fails.
 */
export function renameAsideToTemp(from: string, kind: 'removing' | 'installing'): string {
  const absolute = resolve(from)
  const preferred = skillTransientWorkPath(kind, basename(absolute))
  try {
    renameSync(absolute, preferred)
    return preferred
  } catch {
    const sibling = `${absolute}.__ae_${kind}_${process.pid}_${Date.now()}`
    renameSync(absolute, sibling)
    return sibling
  }
}

export function removeQuietly(path: string): void {
  try {
    const stat = lstatSync(path)
    // Junction / symlink: unlink the mount only — never recursive-rm the target
    // (skills-manager central store when ~/.agents/skills/<name> was a junction).
    if (stat.isSymbolicLink()) {
      try {
        unlinkSync(path)
      } catch {
        // best-effort
      }
      return
    }
  } catch {
    return
  }
  if (!existsSync(path)) return
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 })
  } catch {
    // best-effort
  }
}
