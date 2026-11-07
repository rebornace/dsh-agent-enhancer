import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { AuxiliaryError } from '../../errors.ts'
import { isKebabCaseName, samePath } from './paths.ts'
import { removePathRobust } from './uninstall.ts'

export type SkillInstallTarget = 'user' | 'project'
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
): string {
  return target === 'user'
    ? join(resolve(agentsHome), 'skills')
    : join(resolve(projectRoot), '.agents', 'skills')
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

function linkOrCopy(
  source: string,
  dest: string,
  mode: SkillInstallMode,
): 'link' | 'copy' {
  mkdirSync(dirname(dest), { recursive: true })
  if (mode === 'copy') {
    cpSync(source, dest, { recursive: true })
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
    cpSync(source, dest, { recursive: true })
    return 'copy'
  }
}

export function installBundle(options: {
  readonly bundle: SkillBundle
  readonly targetDir: string
  readonly force: boolean
  readonly mode: SkillInstallMode
}): { readonly path: string, readonly name: string, readonly mode: 'link' | 'copy' } {
  const dest = destinationForBundle(options.targetDir, options.bundle)
  if (destinationPresent(dest)) {
    if (options.force || isStaleSkillDestination(dest, options.bundle.kind)) {
      removeDestination(dest)
    } else {
      throw new AuxiliaryError('FILE_DENIED', `A skill named ${options.bundle.name} already exists`)
    }
  }
  const used = linkOrCopy(options.bundle.sourcePath, dest, options.mode)
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
