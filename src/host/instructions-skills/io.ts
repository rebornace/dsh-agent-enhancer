import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AuxiliaryError } from '../../errors.ts'
import { pickFileNow } from '../extra-folders/pick.ts'
import { createWorkspaceAgentsFile, createWorkspaceSkill } from './create.ts'
import {
  discoverFilesystemSkills,
  discoverInstructionFiles,
  mergeSkillCatalogs,
  normalizeRegistrySkills,
} from './discover.ts'
import { parseGitSkillSource } from './git-source.ts'
import { readInstallLedger } from './install-ledger.ts'
import { installSkillsFromGit } from './install.ts'
import { samePath, skillRootsFor } from './paths.ts'
import { uninstallManagedSkill } from './uninstall.ts'
import { checkGithubSkillUpdate } from './update-check.ts'
import { installSkillsFromZipFile } from './zip-install.ts'
import type {
  CreateWorkspaceAgentsRequest,
  CreateWorkspaceAgentsResult,
  CreateWorkspaceSkillRequest,
  CreateWorkspaceSkillResult,
  InstallSkillFromGitRequest,
  InstallSkillFromGitResult,
  InstallSkillFromZipRequest,
  InstallSkillFromZipResult,
  InstructionsSkillsSnapshot,
  ListInstructionsSkillsRequest,
  SkillCatalogEntry,
  SkillInstallTarget,
  UninstallSkillRequest,
  UninstallSkillResult,
  UpdateSkillFromGitRequest,
  UpdateSkillFromGitResult,
} from './types.ts'
import { defaultSkillInstallMeta } from './types.ts'

interface SessionLike {
  readonly header?: { readonly cwd?: string }
  requestHeader?(): { readonly cwd?: string } | undefined
}

interface AgentLike {
  readonly session?: SessionLike
}

interface SkillsRegistryLike {
  list?(options?: { readonly cwd?: string }): unknown
  snapshot?(options?: { readonly cwd?: string }): unknown
}

function sessionCwd(session: SessionLike | undefined): string {
  const header = session?.header
  if (typeof header?.cwd === 'string' && header.cwd.trim() !== '') return resolve(header.cwd)
  try {
    const requested = session?.requestHeader?.()
    if (typeof requested?.cwd === 'string' && requested.cwd.trim() !== '') {
      return resolve(requested.cwd)
    }
  } catch {
    // ignore
  }
  throw new AuxiliaryError('SESSION_CHANGED', 'Session workspace is unavailable')
}

function agentOf(ctx: Context, sessionId: SessionId): AgentLike {
  const agent = ctx.agents.get(sessionId) as AgentLike | undefined
  if (agent === undefined) {
    throw new AuxiliaryError('SESSION_CHANGED', 'Session is not available')
  }
  return agent
}

function softSkillsRegistry(ctx: Context): SkillsRegistryLike | undefined {
  try {
    const value = ctx.get('skills') as unknown
    if (value === null || value === undefined || typeof value !== 'object') return undefined
    return value as SkillsRegistryLike
  } catch {
    return undefined
  }
}

async function loadRegistrySkills(
  ctx: Context,
  cwd: string,
): Promise<readonly SkillCatalogEntry[] | undefined> {
  const registry = softSkillsRegistry(ctx)
  if (registry === undefined) return undefined

  const tryCall = async (method: 'list' | 'snapshot'): Promise<unknown> => {
    const fn = registry[method]
    if (typeof fn !== 'function') return undefined
    try {
      return await Promise.resolve(fn.call(registry, { cwd }))
    } catch {
      try {
        return await Promise.resolve(fn.call(registry))
      } catch {
        return undefined
      }
    }
  }

  const fromList = normalizeRegistrySkills(await tryCall('list'))
  if (fromList !== undefined) return fromList
  return normalizeRegistrySkills(await tryCall('snapshot'))
}

function ledgerSourceLabel(source: string | null): string | null {
  if (source === null || source.trim() === '') return null
  try {
    return parseGitSkillSource(source).label
  } catch {
    return source.trim()
  }
}

export async function enrichSkillsFromLedger(
  skills: readonly SkillCatalogEntry[],
  options: {
    readonly installLedgerRoot?: string
    readonly signal: AbortSignal
  },
): Promise<readonly SkillCatalogEntry[]> {
  const ledgerRoot = options.installLedgerRoot?.trim()
  if (ledgerRoot === undefined || ledgerRoot === '') {
    return skills.map(skill => ({ ...defaultSkillInstallMeta(), ...skill }))
  }
  const ledger = readInstallLedger(ledgerRoot)
  const out: SkillCatalogEntry[] = []
  for (const skill of skills) {
    const record = ledger[skill.name]
    let entry: SkillCatalogEntry = { ...defaultSkillInstallMeta(), ...skill }
    if (record === undefined) {
      out.push(entry)
      continue
    }
    entry = {
      ...entry,
      installChannel: record.channel,
      updateSourceLabel: ledgerSourceLabel(record.source),
    }
    if (record.channel === 'github' && record.updateCheck) {
      try {
        const check = await checkGithubSkillUpdate(record, { signal: options.signal })
        entry = {
          ...entry,
          updateAvailable: check.updateAvailable,
          updateSourceLabel: check.updateSourceLabel ?? entry.updateSourceLabel,
          updateCheckFailed: check.updateCheckFailed,
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        entry = {
          ...entry,
          updateAvailable: false,
          updateCheckFailed: true,
        }
      }
    }
    out.push(entry)
  }
  return out
}

function inferSkillInstallTarget(
  name: string,
  cwd: string,
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): SkillInstallTarget {
  const roots = skillRootsFor(cwd, projectRoot, env)
  const projectAgents = join(resolve(projectRoot), '.agents', 'skills')
  const projectDsh = join(resolve(projectRoot), '.dsh', 'skills')
  for (const root of roots) {
    const present = existsSync(join(root, name, 'SKILL.md'))
      || existsSync(join(root, `${name}.md`))
    if (!present) continue
    if (samePath(root, projectAgents) || samePath(root, projectDsh)) return 'project'
    return 'user'
  }
  throw new AuxiliaryError('FILE_NOT_FOUND', `Skill is not installed in a managed skills root: ${name}`)
}

async function buildSnapshot(
  ctx: Context,
  sessionId: SessionId,
  cwd: string,
  options?: {
    readonly installLedgerRoot?: string
    readonly signal?: AbortSignal
  },
): Promise<InstructionsSkillsSnapshot> {
  const discovered = discoverInstructionFiles({ cwd })
  const filesystemSkills = discoverFilesystemSkills({
    cwd,
    projectRoot: discovered.projectRoot,
  })
  const registrySkills = await loadRegistrySkills(ctx, cwd)
  const merged = mergeSkillCatalogs(filesystemSkills, registrySkills, {
    cwd,
    projectRoot: discovered.projectRoot,
  })
  const signal = options?.signal ?? new AbortController().signal
  const skills = await enrichSkillsFromLedger(merged.skills, {
    installLedgerRoot: options?.installLedgerRoot,
    signal,
  })
  return {
    sessionId,
    cwd,
    projectRoot: discovered.projectRoot,
    instructions: discovered.instructions,
    skills,
    skillsSource: merged.source,
  }
}

export async function listInstructionsSkillsNow(options: {
  readonly ctx: Context
  readonly request: ListInstructionsSkillsRequest
  readonly signal: AbortSignal
  readonly installLedgerRoot?: string
}): Promise<InstructionsSkillsSnapshot> {
  options.signal.throwIfAborted()
  const agent = agentOf(options.ctx, options.request.sessionId)
  const cwd = sessionCwd(agent.session)
  options.signal.throwIfAborted()
  return buildSnapshot(options.ctx, options.request.sessionId, cwd, {
    installLedgerRoot: options.installLedgerRoot,
    signal: options.signal,
  })
}

export async function createWorkspaceAgentsNow(options: {
  readonly ctx: Context
  readonly request: CreateWorkspaceAgentsRequest
  readonly signal: AbortSignal
  readonly installLedgerRoot?: string
}): Promise<CreateWorkspaceAgentsResult> {
  options.signal.throwIfAborted()
  const agent = agentOf(options.ctx, options.request.sessionId)
  const cwd = sessionCwd(agent.session)
  const discovered = discoverInstructionFiles({ cwd })
  const created = createWorkspaceAgentsFile(discovered.projectRoot)
  options.signal.throwIfAborted()
  const snapshot = await buildSnapshot(options.ctx, options.request.sessionId, cwd, {
    installLedgerRoot: options.installLedgerRoot,
    signal: options.signal,
  })
  return { path: created.path, created: created.created, snapshot }
}

export async function createWorkspaceSkillNow(options: {
  readonly ctx: Context
  readonly request: CreateWorkspaceSkillRequest
  readonly signal: AbortSignal
  readonly installLedgerRoot?: string
}): Promise<CreateWorkspaceSkillResult> {
  options.signal.throwIfAborted()
  const agent = agentOf(options.ctx, options.request.sessionId)
  const cwd = sessionCwd(agent.session)
  const discovered = discoverInstructionFiles({ cwd })
  const created = createWorkspaceSkill(discovered.projectRoot, options.request.name)
  options.signal.throwIfAborted()
  const snapshot = await buildSnapshot(options.ctx, options.request.sessionId, cwd, {
    installLedgerRoot: options.installLedgerRoot,
    signal: options.signal,
  })
  return { path: created.path, created: created.created, snapshot }
}

export async function installSkillFromGitNow(options: {
  readonly ctx: Context
  readonly request: InstallSkillFromGitRequest
  readonly signal: AbortSignal
  readonly installLedgerRoot?: string
}): Promise<InstallSkillFromGitResult> {
  options.signal.throwIfAborted()
  const agent = agentOf(options.ctx, options.request.sessionId)
  const cwd = sessionCwd(agent.session)
  const discovered = discoverInstructionFiles({ cwd })
  const installed = await installSkillsFromGit({
    source: options.request.source,
    target: options.request.target,
    projectRoot: discovered.projectRoot,
    force: options.request.force === true,
    signal: options.signal,
    installLedgerRoot: options.installLedgerRoot,
  })
  options.signal.throwIfAborted()
  const snapshot = await buildSnapshot(options.ctx, options.request.sessionId, cwd, {
    installLedgerRoot: options.installLedgerRoot,
    signal: options.signal,
  })
  return { installed, snapshot }
}

export async function installSkillFromZipNow(options: {
  readonly ctx: Context
  readonly request: InstallSkillFromZipRequest
  readonly signal: AbortSignal
  readonly installLedgerRoot?: string
}): Promise<InstallSkillFromZipResult> {
  options.signal.throwIfAborted()
  const agent = agentOf(options.ctx, options.request.sessionId)
  const cwd = sessionCwd(agent.session)
  const discovered = discoverInstructionFiles({ cwd })

  let zipPath = typeof options.request.zipPath === 'string' ? options.request.zipPath.trim() : ''
  if (zipPath === '') {
    const picked = await pickFileNow(options.signal, {
      title: 'Select skills zip',
      filters: [{ name: 'Zip archives', extensions: ['zip'] }],
    })
    if (picked.path === null) {
      const snapshot = await buildSnapshot(options.ctx, options.request.sessionId, cwd, {
        installLedgerRoot: options.installLedgerRoot,
        signal: options.signal,
      })
      return { cancelled: true, installed: [], zipPath: null, snapshot }
    }
    zipPath = picked.path
  }

  const installed = await installSkillsFromZipFile({
    zipPath,
    target: options.request.target,
    projectRoot: discovered.projectRoot,
    force: options.request.force === true,
    signal: options.signal,
    installLedgerRoot: options.installLedgerRoot,
  })
  options.signal.throwIfAborted()
  const snapshot = await buildSnapshot(options.ctx, options.request.sessionId, cwd, {
    installLedgerRoot: options.installLedgerRoot,
    signal: options.signal,
  })
  return { cancelled: false, installed, zipPath, snapshot }
}

export async function uninstallSkillNow(options: {
  readonly ctx: Context
  readonly request: UninstallSkillRequest
  readonly signal: AbortSignal
  readonly installLedgerRoot?: string
}): Promise<UninstallSkillResult> {
  options.signal.throwIfAborted()
  const agent = agentOf(options.ctx, options.request.sessionId)
  const cwd = sessionCwd(agent.session)
  const discovered = discoverInstructionFiles({ cwd })
  const removed = uninstallManagedSkill({
    name: options.request.name,
    path: options.request.path,
    cwd,
    projectRoot: discovered.projectRoot,
    installLedgerRoot: options.installLedgerRoot,
  })
  options.signal.throwIfAborted()
  const snapshot = await buildSnapshot(options.ctx, options.request.sessionId, cwd, {
    installLedgerRoot: options.installLedgerRoot,
    signal: options.signal,
  })
  return { name: removed.name, removedPath: removed.removedPath, snapshot }
}

export async function updateSkillFromGitNow(options: {
  readonly ctx: Context
  readonly request: UpdateSkillFromGitRequest
  readonly signal: AbortSignal
  readonly installLedgerRoot?: string
}): Promise<UpdateSkillFromGitResult> {
  options.signal.throwIfAborted()
  const ledgerRoot = options.installLedgerRoot?.trim()
  if (ledgerRoot === undefined || ledgerRoot === '') {
    throw new AuxiliaryError('FILE_DENIED', 'Skill install ledger is unavailable')
  }
  const record = readInstallLedger(ledgerRoot)[options.request.name]
  if (record === undefined || record.channel !== 'github') {
    throw new AuxiliaryError('FILE_NOT_FOUND', `No GitHub install record for skill: ${options.request.name}`)
  }
  const source = record.source?.trim() ?? ''
  if (source === '') {
    throw new AuxiliaryError('FILE_DENIED', 'Install record is missing a git source')
  }
  const agent = agentOf(options.ctx, options.request.sessionId)
  const cwd = sessionCwd(agent.session)
  const discovered = discoverInstructionFiles({ cwd })
  const target = inferSkillInstallTarget(
    options.request.name,
    cwd,
    discovered.projectRoot,
  )
  const installed = await installSkillsFromGit({
    source,
    target,
    projectRoot: discovered.projectRoot,
    force: true,
    signal: options.signal,
    installLedgerRoot: ledgerRoot,
  })
  options.signal.throwIfAborted()
  const updated = installed.find(entry => entry.name === options.request.name)
  if (updated === undefined) {
    throw new AuxiliaryError(
      'FILE_NOT_FOUND',
      `Skill ${options.request.name} was not present in the git source`,
    )
  }
  const snapshot = await buildSnapshot(options.ctx, options.request.sessionId, cwd, {
    installLedgerRoot: ledgerRoot,
    signal: options.signal,
  })
  return { updated, snapshot }
}
