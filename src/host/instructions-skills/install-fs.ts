import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { AuxiliaryError } from '../../errors.ts'
import { busyPathHint, isWindowsPathBusyError } from './fs-access.ts'
import { isKebabCaseName, samePath } from './paths.ts'
import {
  isTransientSkillEntryName,
  removeQuietly,
  skillTransientWorkPath,
  sweepTransientSkillEntries,
} from './transient-paths.ts'
import { removePathRobust } from './uninstall.ts'

/**
 * Where to materialize a skill tree.
 * - `user` / `project` → `.agents/skills` (cross-tool Agents convention)
 * - `user-dsh` / `project-dsh` → `.dsh/skills` (Harness-local store)
 */
export type SkillInstallTarget = 'user' | 'user-dsh' | 'project' | 'project-dsh'
export type SkillInstallMode = 'link' | 'copy'

export interface SkillBundle {
  readonly name: string
  readonly sourcePath: string
  /** `directory` = folder with SKILL.md; `file` = flat name.md */
  readonly kind: 'directory' | 'file'
}

function frontmatterBlock(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8')
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

export function descriptionFromSkillPath(path: string): string {
  const block = frontmatterBlock(path)
  if (block === null) return ''
  const desc = /^description:\s*(?:"([^"]*)"|'([^']*)'|(.+))\s*$/m.exec(block)
  if (desc === null) return ''
  return (desc[1] ?? desc[2] ?? desc[3] ?? '').trim()
}

/**
 * Prefer SKILL.md frontmatter `name:` over the folder basename.
 * Zip/GitHub archives often unpack as `repo-hash/` which is a bad install id.
 */
export function nameFromSkillPath(path: string, fallback: string): string {
  const block = frontmatterBlock(path)
  if (block !== null) {
    const named = /^name:\s*(?:"([^"]*)"|'([^']*)'|(.+))\s*$/m.exec(block)
    const value = (named?.[1] ?? named?.[2] ?? named?.[3] ?? '').trim()
    if (isKebabCaseName(value)) return value
  }
  return fallback
}

function directoryBundleName(dir: string, folderName: string): string {
  return nameFromSkillPath(join(dir, 'SKILL.md'), folderName)
}

/** Discover skill bundles under a directory (single-level, official provider shape). */
export function findSkillBundles(root: string): readonly SkillBundle[] {
  const absolute = resolve(root)
  if (!existsSync(absolute)) return []

  // Root itself is a skill directory.
  const rootSkill = join(absolute, 'SKILL.md')
  if (existsSync(rootSkill)) {
    const folderName = basename(absolute)
    const name = directoryBundleName(absolute, folderName)
    if (isKebabCaseName(name)) {
      return [{ name, sourcePath: absolute, kind: 'directory' }]
    }
  }

  const out: SkillBundle[] = []
  let entries: string[]
  try {
    entries = readdirSync(absolute)
  } catch {
    return []
  }
  for (const entry of entries) {
    if (isTransientSkillEntryName(entry)) continue
    const full = join(absolute, entry)
    if (existsSync(join(full, 'SKILL.md'))) {
      const name = directoryBundleName(full, entry)
      if (!isKebabCaseName(name)) continue
      out.push({ name, sourcePath: full, kind: 'directory' })
      continue
    }
    let isFile = false
    try {
      isFile = lstatSync(full).isFile()
    } catch {
      continue
    }
    if (isFile && entry.toLowerCase().endsWith('.md') && entry.toLowerCase() !== 'readme.md') {
      const name = entry.replace(/\.md$/i, '')
      if (!isKebabCaseName(name)) continue
      out.push({ name, sourcePath: full, kind: 'file' })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function resolveBundlesFromClone(
  cloneRoot: string,
  subpath: string | null,
): readonly SkillBundle[] {
  const base = subpath === null || subpath === ''
    ? resolve(cloneRoot)
    : resolve(cloneRoot, subpath)

  if (!existsSync(base)) {
    throw new AuxiliaryError('FILE_NOT_FOUND', `Path not found in repository: ${subpath ?? '.'}`)
  }

  // Explicit SKILL.md file path
  if (base.toLowerCase().endsWith('skill.md') && existsSync(base)) {
    const dir = dirname(base)
    const name = directoryBundleName(dir, basename(dir))
    if (!isKebabCaseName(name)) {
      throw new AuxiliaryError('FILE_DENIED', `Skill directory name must be kebab-case: ${name}`)
    }
    return [{ name, sourcePath: dir, kind: 'directory' }]
  }

  const direct = findSkillBundles(base)
  if (direct.length > 0) return direct

  // Common layouts: skills/, .agents/skills/, .dsh/skills/
  for (const rel of ['skills', join('.agents', 'skills'), join('.dsh', 'skills')] as const) {
    const nested = join(base, rel)
    const found = findSkillBundles(nested)
    if (found.length > 0) return found
  }

  throw new AuxiliaryError('FILE_NOT_FOUND', 'No SKILL.md bundles found in the repository path')
}

export function installTargetDir(
  target: SkillInstallTarget,
  projectRoot: string,
  agentsHome: string,
  dshHome: string,
): string {
  switch (target) {
    case 'user':
      return join(resolve(agentsHome), 'skills')
    case 'user-dsh':
      return join(resolve(dshHome), 'skills')
    case 'project':
      return join(resolve(projectRoot), '.agents', 'skills')
    case 'project-dsh':
      return join(resolve(projectRoot), '.dsh', 'skills')
    default: {
      const _exhaustive: never = target
      return _exhaustive
    }
  }
}

export function destinationForBundle(
  targetDir: string,
  bundle: SkillBundle,
): string {
  return bundle.kind === 'directory'
    ? join(targetDir, bundle.name)
    : join(targetDir, `${bundle.name}.md`)
}

function removeDestination(dest: string): void {
  removePathRobust(dest)
}

/** Path exists including broken junctions / symlinks (Windows leftovers). */
function destinationPresent(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * A leftover install target that is not a usable skill (empty dir, broken
 * junction, or missing SKILL.md) — safe to clear without `force`.
 */
export function isStaleSkillDestination(
  dest: string,
  kind: SkillBundle['kind'],
): boolean {
  if (!destinationPresent(dest)) return false
  if (kind === 'file') {
    try {
      const stat = lstatSync(dest)
      if (stat.isSymbolicLink()) return !existsSync(dest)
      return !stat.isFile()
    } catch {
      return true
    }
  }
  // Directory bundle: must contain a readable SKILL.md (follow links).
  return !existsSync(join(dest, 'SKILL.md'))
}

function copySkillTree(source: string, dest: string): void {
  try {
    cpSync(source, dest, { recursive: true })
  } catch (error) {
    if (isWindowsPathBusyError(error)) {
      throw new AuxiliaryError('FILE_EDIT_FAILED', busyPathHint(basename(dest)))
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new AuxiliaryError(
      'FILE_EDIT_FAILED',
      `Failed to copy skill into ${basename(dest)}: ${detail.slice(0, 400)}`,
    )
  }
}

/**
 * Copy into OS-temp staging, then rename over `dest`.
 * Avoids writing through a leftover Windows junction into skills-manager,
 * and never leaves discoverable siblings under the skills root.
 */
function copySkillTreeAtomic(source: string, dest: string, kind: SkillBundle['kind']): void {
  mkdirSync(dirname(dest), { recursive: true })
  if (kind === 'file') {
    if (destinationPresent(dest)) removeDestination(dest)
    copySkillTree(source, dest)
    return
  }
  const staging = skillTransientWorkPath('installing', basename(dest))
  try {
    copySkillTree(source, staging)
    if (destinationPresent(dest)) removeDestination(dest)
    if (destinationPresent(dest)) {
      throw new AuxiliaryError('FILE_EDIT_FAILED', busyPathHint(basename(dest)))
    }
    try {
      renameSync(staging, dest)
    } catch (error) {
      if (isWindowsPathBusyError(error)) {
        throw new AuxiliaryError('FILE_EDIT_FAILED', busyPathHint(basename(dest)))
      }
      // Last resort: copy into place if rename across volumes fails.
      copySkillTree(staging, dest)
      removeQuietly(staging)
    }
  } catch (error) {
    removeQuietly(staging)
    throw error
  }
}

function linkOrCopy(
  source: string,
  dest: string,
  mode: SkillInstallMode,
  kind: SkillBundle['kind'],
): 'link' | 'copy' {
  mkdirSync(dirname(dest), { recursive: true })
  if (mode === 'copy') {
    copySkillTreeAtomic(source, dest, kind)
    return 'copy'
  }
  try {
    if (process.platform === 'win32') {
      // Directory junction (no admin); for files use symlink and fall back.
      const stat = lstatSync(source)
      if (stat.isDirectory() || (stat.isSymbolicLink() && existsSync(join(source, 'SKILL.md')))) {
        symlinkSync(source, dest, 'junction')
        return 'link'
      }
      symlinkSync(source, dest, 'file')
      return 'link'
    }
    symlinkSync(source, dest)
    return 'link'
  } catch {
    copySkillTreeAtomic(source, dest, kind)
    return 'copy'
  }
}

export function installBundle(options: {
  readonly bundle: SkillBundle
  readonly targetDir: string
  readonly force: boolean
  readonly mode: SkillInstallMode
}): { readonly path: string, readonly name: string, readonly mode: 'link' | 'copy' } {
  sweepTransientSkillEntries(options.targetDir)
  const dest = destinationForBundle(options.targetDir, options.bundle)
  if (destinationPresent(dest)) {
    if (options.force || isStaleSkillDestination(dest, options.bundle.kind)) {
      removeDestination(dest)
    } else {
      throw new AuxiliaryError('FILE_DENIED', `A skill named ${options.bundle.name} already exists`)
    }
  }
  // Empty Windows shells can look "present" after removePathRobust treats them as
  // effectively gone — atomic copy clears leftovers again before rename.
  const used = linkOrCopy(options.bundle.sourcePath, dest, options.mode, options.bundle.kind)
  return { path: dest, name: options.bundle.name, mode: used }
}

export function isAlreadyInstalled(
  name: string,
  installedRoots: readonly string[],
): boolean {
  for (const root of installedRoots) {
    const dir = join(root, name)
    const file = join(root, `${name}.md`)
    if (existsSync(dir) || existsSync(file)) return true
  }
  return false
}

export function sameBundlePath(a: string, b: string): boolean {
  return samePath(a, b)
}
