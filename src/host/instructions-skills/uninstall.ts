/**
 * Remove a skill that lives under a DSH-managed skills root
 * (user ~/.agents|/.dsh/skills or project .agents|/.dsh/skills).
 */
import { lstatSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { AuxiliaryError } from '../../errors.ts'
import { removeInstallRecord } from './install-ledger.ts'
import { isInsideOrSame, isKebabCaseName, samePath, skillRootsFor } from './paths.ts'
import { removePathRobust } from './remove-path.ts'

export { removePathRobust } from './remove-path.ts'

function skillEntryPath(skillMdOrBundlePath: string): string {
  const absolute = resolve(skillMdOrBundlePath)
  const base = basename(absolute)
  if (base.toLowerCase() === 'skill.md') return dirname(absolute)
  if (base.toLowerCase().endsWith('.md')) return absolute
  return absolute
}

/** True when a path exists on disk, including broken junctions / symlinks. */
export function pathPresent(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Direct-child skill entries for `name` under one managed root
 * (folder and/or flat `name.md`), including broken links.
 */
export function managedSkillEntriesForName(
  root: string,
  name: string,
): readonly string[] {
  if (!isKebabCaseName(name)) return []
  const out: string[] = []
  const asDir = join(root, name)
  const asFile = join(root, `${name}.md`)
  for (const entry of [asDir, asFile]) {
    if (!pathPresent(entry)) continue
    if (!samePath(dirname(entry), root)) continue
    if (!isInsideOrSame(root, entry)) continue
    out.push(entry)
  }
  return out
}

/**
 * Only allow deleting a direct child of a managed skills root
 * (directory with SKILL.md, or a flat `name.md` file).
 */
export function resolveManagedSkillRemovalTarget(
  path: string,
  name: string,
  managedRoots: readonly string[],
): string | null {
  if (!isKebabCaseName(name)) return null
  const entry = skillEntryPath(path)
  for (const root of managedRoots) {
    const asDir = join(root, name)
    const asFile = join(root, `${name}.md`)
    if (samePath(entry, asDir) || samePath(entry, asFile)) {
      // Allow broken junctions so uninstall can clear leftovers that block reinstall.
      if (!pathPresent(entry)) return null
      // Refuse deleting anything that is not a direct child of the root.
      if (!samePath(dirname(entry), root)) return null
      if (!isInsideOrSame(root, entry)) return null
      return entry
    }
  }
  return null
}

export function isRemovableManagedSkillPath(
  path: string | null,
  name: string,
  cwd: string,
  projectRoot: string,
  env?: NodeJS.ProcessEnv,
): boolean {
  if (path === null || path.trim() === '') return false
  const roots = skillRootsFor(cwd, projectRoot, env)
  return resolveManagedSkillRemovalTarget(path, name, roots) !== null
}

/**
 * Remove every managed-root entry for `name` (folder and flat `.md`, including
 * broken links). Used by uninstall and by overwrite installs.
 */
export function purgeManagedSkillName(options: {
  readonly name: string
  readonly cwd: string
  readonly projectRoot: string
  readonly env?: NodeJS.ProcessEnv
  /** Extra absolute paths to remove even if outside the name scan. */
  readonly also?: readonly string[]
}): readonly string[] {
  const name = options.name.trim()
  if (!isKebabCaseName(name)) {
    throw new AuxiliaryError('FILE_DENIED', `Invalid skill name: ${name}`)
  }
  const roots = skillRootsFor(options.cwd, options.projectRoot, options.env)
  const purgeTargets = new Set<string>()
  for (const extra of options.also ?? []) {
    purgeTargets.add(resolve(extra))
  }
  for (const root of roots) {
    for (const entry of managedSkillEntriesForName(root, name)) {
      purgeTargets.add(resolve(entry))
    }
  }
  const removed: string[] = []
  for (const entry of purgeTargets) {
    removePathRobust(entry)
    removed.push(entry)
  }
  return removed
}

export function uninstallManagedSkill(options: {
  readonly name: string
  readonly path: string
  readonly cwd: string
  readonly projectRoot: string
  readonly env?: NodeJS.ProcessEnv
  readonly installLedgerRoot?: string
}): { readonly name: string, readonly removedPath: string } {
  const name = options.name.trim()
  if (!isKebabCaseName(name)) {
    throw new AuxiliaryError('FILE_DENIED', `Invalid skill name: ${name}`)
  }
  const roots = skillRootsFor(options.cwd, options.projectRoot, options.env)
  const target = resolveManagedSkillRemovalTarget(options.path, name, roots)
  if (target === null) {
    throw new AuxiliaryError(
      'FILE_DENIED',
      `Skill is outside managed install roots and cannot be uninstalled from this panel: ${name}`,
    )
  }
  // Purge the same name from every managed root. Skills often land in both
  // ~/.agents/skills and ~/.dsh/skills; removing only the catalog path leaves a
  // sibling that still blocks reinstall (and may vanish from the list when it
  // is an empty/broken leftover without SKILL.md).
  purgeManagedSkillName({
    name,
    cwd: options.cwd,
    projectRoot: options.projectRoot,
    env: options.env,
    also: [target],
  })
  const ledgerRoot = options.installLedgerRoot?.trim()
  if (ledgerRoot !== undefined && ledgerRoot !== '') {
    removeInstallRecord(ledgerRoot, name)
  }
  return { name, removedPath: target }
}
