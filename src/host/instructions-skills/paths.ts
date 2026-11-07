import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

export const INSTRUCTION_CANDIDATES = [
  'AGENTS.md',
  'CLAUDE.md',
  'AGENTS.local.md',
  'CLAUDE.local.md',
] as const

export const PROJECT_ROOT_MARKERS = ['.git'] as const

export function dshHomeOf(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return resolve(homedir(), '.dsh')
}

export function agentsHomeOf(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_AGENTS_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return resolve(homedir(), '.agents')
}

/** Climb toward filesystem root until a project-root marker exists. */
export function findProjectRoot(
  cwd: string,
  markers: readonly string[] = PROJECT_ROOT_MARKERS,
): string {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (existsSync(join(current, marker))) return current
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/** Directories from project root down to cwd (inclusive), broad → specific. */
export function projectChainDirs(projectRoot: string, cwd: string): readonly string[] {
  const root = resolve(projectRoot)
  const tip = resolve(cwd)
  if (!isInsideOrSame(root, tip)) return [root]

  const parts: string[] = []
  let current = tip
  for (;;) {
    parts.push(current)
    if (samePath(current, root)) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return parts.reverse()
}

/**
 * Local skill roots aligned with `@deepseek-ai/dsh-skill-filesystem`:
 * project `.agents/skills` + `.dsh/skills`, then user `~/.agents/skills` / `~/.dsh/skills`.
 */
export function skillRootsFor(cwd: string, projectRoot: string, env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const root = resolve(projectRoot)
  const tip = resolve(cwd)
  return [
    join(root, '.agents', 'skills'),
    join(root, '.dsh', 'skills'),
    join(tip, '.agents', 'skills'),
    join(tip, '.dsh', 'skills'),
    join(agentsHomeOf(env), 'skills'),
    join(dshHomeOf(env), 'skills'),
  ].filter((path, index, all) => all.findIndex(other => samePath(other, path)) === index)
}

export function fileBytes(path: string): number | null {
  try {
    const stat = statSync(path)
    return stat.isFile() ? stat.size : null
  } catch {
    return null
  }
}

export function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase()
}

export function isInsideOrSame(root: string, candidate: string): boolean {
  const base = resolve(root).toLowerCase()
  const path = resolve(candidate).toLowerCase()
  if (path === base) return true
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  return path.startsWith(prefix)
}

export function displayNameOf(path: string): string {
  const name = basename(path)
  return name === '' ? path : name
}

/** kebab-case skill / folder names. */
export function isKebabCaseName(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)
}
