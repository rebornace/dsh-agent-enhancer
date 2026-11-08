import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  InstructionFileEntry,
  InstructionScope,
  SkillCatalogEntry,
} from './types.ts'
import { defaultSkillInstallMeta } from './types.ts'
import {
  INSTRUCTION_CANDIDATES,
  agentsHomeOf,
  displayNameOf,
  dshHomeOf,
  fileBytes,
  findProjectRoot,
  projectChainDirs,
  previewSkillSearchRoots,
  samePath,
  skillRootsFor,
} from './paths.ts'
import { isTransientSkillEntryName, sweepTransientSkillEntries } from './transient-paths.ts'
import { isRemovableManagedSkillPath } from './uninstall.ts'

export interface DiscoverOptions {
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
}

export interface DiscoveredInstructions {
  readonly projectRoot: string
  readonly instructions: readonly InstructionFileEntry[]
}

function entryId(scope: InstructionScope, path: string): string {
  return `${scope}:${resolve(path).toLowerCase()}`
}

function pushUnique(
  out: InstructionFileEntry[],
  seen: Set<string>,
  entry: InstructionFileEntry,
): void {
  const key = resolve(entry.path).toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  out.push(entry)
}

export function discoverInstructionFiles(options: DiscoverOptions): DiscoveredInstructions {
  const env = options.env ?? process.env
  const cwd = resolve(options.cwd)
  const projectRoot = findProjectRoot(cwd)
  const seen = new Set<string>()
  const instructions: InstructionFileEntry[] = []

  const globalPath = join(dshHomeOf(env), 'AGENTS.md')
  pushUnique(instructions, seen, {
    id: entryId('global', globalPath),
    scope: 'global',
    name: 'AGENTS.md',
    path: globalPath,
    exists: existsSync(globalPath),
    bytes: fileBytes(globalPath),
    createable: false,
  })

  const sharedPath = join(agentsHomeOf(env), 'AGENTS.md')
  pushUnique(instructions, seen, {
    id: entryId('shared', sharedPath),
    scope: 'shared',
    name: 'AGENTS.md',
    path: sharedPath,
    exists: existsSync(sharedPath),
    bytes: fileBytes(sharedPath),
    createable: false,
  })

  const rootAgents = join(projectRoot, 'AGENTS.md')
  pushUnique(instructions, seen, {
    id: entryId('project', rootAgents),
    scope: 'project',
    name: 'AGENTS.md',
    path: rootAgents,
    exists: existsSync(rootAgents),
    bytes: fileBytes(rootAgents),
    createable: !existsSync(rootAgents),
  })

  for (const dir of projectChainDirs(projectRoot, cwd)) {
    for (const name of INSTRUCTION_CANDIDATES) {
      const path = join(dir, name)
      if (!existsSync(path)) continue
      if (samePath(path, rootAgents)) continue
      pushUnique(instructions, seen, {
        id: entryId('project', path),
        scope: 'project',
        name: displayNameOf(path),
        path,
        exists: true,
        bytes: fileBytes(path),
        createable: false,
      })
    }
  }

  return { projectRoot, instructions }
}

function descriptionFromSkillMd(path: string): string {
  try {
    const text = readFileSync(path, 'utf8')
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (match === null) return ''
    const block = match[1]!
    const desc = /^description:\s*(?:"([^"]*)"|'([^']*)'|(.+))\s*$/m.exec(block)
    if (desc === null) return ''
    return (desc[1] ?? desc[2] ?? desc[3] ?? '').trim()
  } catch {
    return ''
  }
}

export function discoverFilesystemSkills(options: DiscoverOptions & {
  readonly projectRoot: string
}): readonly SkillCatalogEntry[] {
  const env = options.env ?? process.env
  const managed = skillRootsFor(options.cwd, options.projectRoot, env)
  const roots = previewSkillSearchRoots(options.cwd, options.projectRoot, env)
  const byName = new Map<string, SkillCatalogEntry>()

  for (const root of roots) {
    const managedRoot = managed.some(path => samePath(path, root))
    if (managedRoot) sweepTransientSkillEntries(root)
    let names: string[]
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      if (isTransientSkillEntryName(name)) continue
      const skillMd = join(root, name, 'SKILL.md')
      if (!existsSync(skillMd)) continue
      if (byName.has(name)) continue
      byName.set(name, {
        id: `fs:${resolve(skillMd).toLowerCase()}`,
        name,
        description: descriptionFromSkillMd(skillMd),
        path: resolve(skillMd),
        provider: dirnameLabel(root, options.projectRoot, env),
        modelInvocable: null,
        userInvocable: null,
        // Only managed install roots are uninstallable from this panel.
        removable: managedRoot,
        ...defaultSkillInstallMeta(),
      })
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function dirnameLabel(root: string, projectRoot: string, env: NodeJS.ProcessEnv): string {
  if (samePath(root, join(projectRoot, '.agents', 'skills'))) return 'project'
  if (samePath(root, join(projectRoot, '.dsh', 'skills'))) return 'project-dsh'
  if (samePath(root, join(agentsHomeOf(env), 'skills'))) return 'shared'
  if (samePath(root, join(dshHomeOf(env), 'skills'))) return 'dsh-home'
  const parent = basename(dirname(root)).toLowerCase()
  const leaf = basename(root).toLowerCase()
  if (parent === '.cursor' && leaf === 'skills') return 'cursor'
  if (parent === '.cursor' && leaf === 'skills-cursor') return 'cursor-builtin'
  if (parent === '.codex') return 'codex'
  if (parent === '.claude') return 'claude'
  return parent || 'filesystem'
}

export interface SoftSkillSummary {
  readonly name?: unknown
  readonly description?: unknown
  readonly path?: unknown
  readonly provider?: unknown
  readonly modelInvocable?: unknown
  readonly userInvocable?: unknown
}

export function normalizeRegistrySkills(
  raw: unknown,
): readonly SkillCatalogEntry[] | undefined {
  const list = extractSkillArray(raw)
  if (list === undefined) return undefined
  const out: SkillCatalogEntry[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const row = item as SoftSkillSummary
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    const path = typeof row.path === 'string' && row.path.trim() !== ''
      ? resolve(row.path.trim())
      : null
    out.push({
      id: path !== null ? `reg:${path.toLowerCase()}` : `reg:${name}`,
      name,
      description: typeof row.description === 'string' ? row.description.trim() : '',
      path,
      provider: typeof row.provider === 'string' && row.provider.trim() !== ''
        ? row.provider.trim()
        : 'registry',
      modelInvocable: typeof row.modelInvocable === 'boolean' ? row.modelInvocable : null,
      userInvocable: typeof row.userInvocable === 'boolean' ? row.userInvocable : null,
      removable: false,
      ...defaultSkillInstallMeta(),
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Installed tab must show disk skills even when soft `ctx.skills` is empty/stale
 * (common right after GitHub install — registry has not rescaned yet).
 * Filesystem wins for path/presence; registry enriches invocable flags / description.
 */
/** Prefer a real SKILL.md path so the client can open document preview. */
function coerceSkillDocumentPath(path: string | null, _name: string): string | null {
  if (path === null || path.trim() === '') return null
  const absolute = resolve(path.trim())
  if (existsSync(absolute)) {
    try {
      if (statSync(absolute).isFile()) return absolute
    } catch {
      // fall through to SKILL.md join
    }
    const asFile = join(absolute, 'SKILL.md')
    if (existsSync(asFile)) return asFile
  }
  const lower = absolute.toLowerCase()
  if (lower.endsWith('skill.md') || lower.endsWith('.md')) return absolute
  const nested = join(absolute, 'SKILL.md')
  return existsSync(nested) ? nested : absolute
}

function resolveSkillPathFromRoots(
  name: string,
  cwd: string,
  projectRoot: string,
  env: NodeJS.ProcessEnv,
): string | null {
  for (const root of previewSkillSearchRoots(cwd, projectRoot, env)) {
    const skillMd = join(root, name, 'SKILL.md')
    if (existsSync(skillMd)) return resolve(skillMd)
  }
  return null
}

/** Fill missing paths and coerce directories → SKILL.md for preview. */
export function hydrateSkillPreviewPaths(
  skills: readonly SkillCatalogEntry[],
  options: {
    readonly cwd: string
    readonly projectRoot: string
    readonly env?: NodeJS.ProcessEnv
  },
): readonly SkillCatalogEntry[] {
  const env = options.env ?? process.env
  return skills.map(entry => {
    const fromRoots = entry.path === null
      ? resolveSkillPathFromRoots(entry.name, options.cwd, options.projectRoot, env)
      : null
    const path = coerceSkillDocumentPath(entry.path ?? fromRoots, entry.name)
    if (path === entry.path) return entry
    return { ...entry, path }
  })
}

export function mergeSkillCatalogs(
  filesystem: readonly SkillCatalogEntry[],
  registry: readonly SkillCatalogEntry[] | undefined,
  options?: {
    readonly cwd?: string
    readonly projectRoot?: string
    readonly env?: NodeJS.ProcessEnv
  },
): { readonly skills: readonly SkillCatalogEntry[], readonly source: 'filesystem' | 'registry' | 'merged' } {
  const withRemovable = (entry: SkillCatalogEntry): SkillCatalogEntry => {
    if (entry.removable) return entry
    if (options?.cwd === undefined || options.projectRoot === undefined) return entry
    return {
      ...entry,
      removable: isRemovableManagedSkillPath(
        entry.path,
        entry.name,
        options.cwd,
        options.projectRoot,
        options.env,
      ),
    }
  }

  let skills: SkillCatalogEntry[]
  let source: 'filesystem' | 'registry' | 'merged'
  if (registry === undefined) {
    skills = filesystem.map(withRemovable)
    source = 'filesystem'
  } else if (filesystem.length === 0) {
    skills = registry.map(withRemovable)
    source = 'registry'
  } else {
    const byName = new Map<string, SkillCatalogEntry>()
    for (const entry of filesystem) {
      byName.set(entry.name, withRemovable(entry))
    }
    for (const entry of registry) {
      const existing = byName.get(entry.name)
      if (existing === undefined) {
        byName.set(entry.name, withRemovable(entry))
        continue
      }
      byName.set(entry.name, {
        id: existing.id,
        name: existing.name,
        description: existing.description !== '' ? existing.description : entry.description,
        path: existing.path ?? entry.path,
        provider: existing.provider,
        modelInvocable: entry.modelInvocable ?? existing.modelInvocable,
        userInvocable: entry.userInvocable ?? existing.userInvocable,
        removable: existing.removable || withRemovable(entry).removable,
        installChannel: existing.installChannel ?? entry.installChannel,
        updateAvailable: existing.updateAvailable || entry.updateAvailable,
        updateSourceLabel: existing.updateSourceLabel ?? entry.updateSourceLabel,
        updateCheckFailed: existing.updateCheckFailed || entry.updateCheckFailed,
      })
    }
    skills = [...byName.values()]
    source = 'merged'
  }

  if (options?.cwd !== undefined && options.projectRoot !== undefined) {
    skills = [...hydrateSkillPreviewPaths(skills, {
      cwd: options.cwd,
      projectRoot: options.projectRoot,
      env: options.env,
    })]
  }

  return {
    skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
    source,
  }
}

function extractSkillArray(raw: unknown): readonly unknown[] | undefined {
  if (Array.isArray(raw)) return raw
  if (raw === null || typeof raw !== 'object') return undefined
  for (const key of ['skills', 'candidates', 'items', 'entries'] as const) {
    const value = Reflect.get(raw, key)
    if (Array.isArray(value)) return value
  }
  return undefined
}
