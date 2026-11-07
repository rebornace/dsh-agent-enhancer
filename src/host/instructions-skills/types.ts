import type { SessionId } from '@deepseek-ai/dsh-session/types'

export type InstructionScope = 'global' | 'shared' | 'project'

export interface InstructionFileEntry {
  readonly id: string
  readonly scope: InstructionScope
  readonly name: string
  readonly path: string
  readonly exists: boolean
  readonly bytes: number | null
  /** True when this is the canonical project-root AGENTS.md create target. */
  readonly createable: boolean
}

export type SkillInstallChannelLabel = 'github' | 'zip' | 'unknown'

export function defaultSkillInstallMeta(): Pick<
  SkillCatalogEntry,
  'installChannel' | 'updateAvailable' | 'updateSourceLabel' | 'updateCheckFailed'
> {
  return {
    installChannel: null,
    updateAvailable: false,
    updateSourceLabel: null,
    updateCheckFailed: false,
  }
}

export interface SkillCatalogEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly path: string | null
  readonly provider: string
  readonly modelInvocable: boolean | null
  readonly userInvocable: boolean | null
  /** True when the skill lives under a managed install root and can be uninstalled here. */
  readonly removable: boolean
  readonly installChannel: SkillInstallChannelLabel | null
  readonly updateAvailable: boolean
  readonly updateSourceLabel: string | null
  /** True when a GitHub update check was attempted but could not complete. */
  readonly updateCheckFailed: boolean
}

export interface InstructionsSkillsSnapshot {
  readonly sessionId: SessionId
  readonly cwd: string
  readonly projectRoot: string
  readonly instructions: readonly InstructionFileEntry[]
  readonly skills: readonly SkillCatalogEntry[]
  readonly skillsSource: 'registry' | 'filesystem' | 'merged'
}

export interface UninstallSkillRequest {
  readonly sessionId: SessionId
  readonly name: string
  readonly path: string
}

export interface UninstallSkillResult {
  readonly name: string
  readonly removedPath: string
  readonly snapshot: InstructionsSkillsSnapshot
}

export interface ListInstructionsSkillsRequest {
  readonly sessionId: SessionId
}

export interface CreateWorkspaceAgentsRequest {
  readonly sessionId: SessionId
}

export interface CreateWorkspaceAgentsResult {
  readonly path: string
  readonly created: boolean
  readonly snapshot: InstructionsSkillsSnapshot
}

export interface CreateWorkspaceSkillRequest {
  readonly sessionId: SessionId
  readonly name: string
}

export interface CreateWorkspaceSkillResult {
  readonly path: string
  readonly created: boolean
  readonly snapshot: InstructionsSkillsSnapshot
}

export type SkillInstallTarget = 'user' | 'project'
export type SkillInstallMode = 'link' | 'copy'

export interface InstallSkillFromGitRequest {
  readonly sessionId: SessionId
  readonly source: string
  readonly target: SkillInstallTarget
  /** When omitted / true, overwrite same-named managed installs. Pass false to refuse. */
  readonly force?: boolean
}

export interface InstallSkillFromGitResult {
  readonly installed: readonly { readonly name: string, readonly path: string, readonly mode: 'link' | 'copy' }[]
  readonly snapshot: InstructionsSkillsSnapshot
}

export interface InstallSkillFromZipRequest {
  readonly sessionId: SessionId
  /** When omitted, the host opens a native zip file picker. */
  readonly zipPath?: string
  readonly target: SkillInstallTarget
  /** When omitted / true, overwrite same-named managed installs. Pass false to refuse. */
  readonly force?: boolean
}

export interface InstallSkillFromZipResult {
  /** True when the native file picker was dismissed. */
  readonly cancelled: boolean
  readonly installed: readonly { readonly name: string, readonly path: string, readonly mode: 'link' | 'copy' }[]
  readonly zipPath: string | null
  readonly snapshot: InstructionsSkillsSnapshot
}

export interface UpdateSkillFromGitRequest {
  readonly sessionId: SessionId
  readonly name: string
}

export interface UpdateSkillFromGitResult {
  readonly updated: { readonly name: string, readonly path: string, readonly mode: 'link' | 'copy' }
  readonly snapshot: InstructionsSkillsSnapshot
}

/** Read SKILL.md for in-panel preview (main panel cannot open the Desktop rightbar). */
export interface ReadSkillDocumentRequest {
  readonly sessionId: SessionId
  /** Skill folder or SKILL.md path from the catalog. */
  readonly path: string
}

export interface ReadSkillDocumentResult {
  readonly path: string
  readonly absolutePath: string
  readonly text: string
  readonly bytes: number
}
