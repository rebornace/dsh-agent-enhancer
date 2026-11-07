/**
 * Remove a skill that lives under a DSH-managed skills root
 * (user ~/.agents|/.dsh/skills or project .agents|/.dsh/skills).
 */
import { existsSync, lstatSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { AuxiliaryError } from '../../errors.ts'
import { removeInstallRecord } from './install-ledger.ts'
import { isInsideOrSame, isKebabCaseName, samePath, skillRootsFor } from './paths.ts'

function skillEntryPath(skillMdOrBundlePath: string): string {
  const absolute = resolve(skillMdOrBundlePath)
  const base = basename(absolute)
  if (base.toLowerCase() === 'skill.md') return dirname(absolute)
  if (base.toLowerCase().endsWith('.md')) return absolute
  return absolute
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
      if (!existsSync(entry)) return null
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
  try {
    const stat = lstatSync(target)
    // Junctions / symlinks: unlink the link itself (rmSync recursive handles both).
    void stat
    rmSync(target, { recursive: true, force: true })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AuxiliaryError('FILE_EDIT_FAILED', `Failed to uninstall ${name}: ${detail}`)
  }
  if (existsSync(target)) {
    throw new AuxiliaryError('FILE_EDIT_FAILED', `Failed to uninstall ${name}: still present`)
  }
  const ledgerRoot = options.installLedgerRoot?.trim()
  if (ledgerRoot !== undefined && ledgerRoot !== '') {
    removeInstallRecord(ledgerRoot, name)
  }
  return { name, removedPath: target }
}
