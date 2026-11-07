import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { AUXILIARY_ERROR_CODES, AuxiliaryError } from '../../errors.ts'
import type { AuxiliaryErrorCode } from '../../errors.ts'
import type {
  CreateWorkspaceAgentsRequest,
  CreateWorkspaceAgentsResult,
  CreateWorkspaceSkillRequest,
  CreateWorkspaceSkillResult,
  InstallSkillFromGitRequest,
  InstallSkillFromGitResult,
  InstructionsSkillsSnapshot,
  ListInstructionsSkillsRequest,
  InstallSkillFromZipRequest,
  InstallSkillFromZipResult,
  ReadSkillDocumentRequest,
  ReadSkillDocumentResult,
  UninstallSkillRequest,
  UninstallSkillResult,
  UpdateSkillFromGitRequest,
  UpdateSkillFromGitResult,
} from '../../host/instructions-skills/types.ts'

function auxiliaryCode(value: unknown, fallback: AuxiliaryErrorCode): AuxiliaryErrorCode {
  return typeof value === 'string' && (AUXILIARY_ERROR_CODES as readonly string[]).includes(value)
    ? value as AuxiliaryErrorCode
    : fallback
}

function agentFace(remote: unknown): object {
  if (remote === null || remote === undefined || typeof remote !== 'object') {
    throw new AuxiliaryError('FILE_EDIT_FAILED', 'agentEnhancer remote is unavailable')
  }
  try {
    const face = Reflect.get(remote, 'agentEnhancer')
    if (face === null || face === undefined || typeof face !== 'object') {
      throw new AuxiliaryError('FILE_EDIT_FAILED', 'agentEnhancer remote is unavailable')
    }
    return face as object
  } catch (error) {
    if (error instanceof AuxiliaryError) throw error
    throw new AuxiliaryError('FILE_EDIT_FAILED', 'agentEnhancer remote is unavailable')
  }
}

type ListCall = (
  request: ListInstructionsSkillsRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<InstructionsSkillsSnapshot>>

type CreateAgentsCall = (
  request: CreateWorkspaceAgentsRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<CreateWorkspaceAgentsResult>>

type CreateSkillCall = (
  request: CreateWorkspaceSkillRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<CreateWorkspaceSkillResult>>

function throwRemoteFailure(result: Extract<RemoteResult<unknown>, { readonly ok: false }>): never {
  const code = result.error.code === 'agent-enhancer/failed'
    ? auxiliaryCode(result.error.details.code, 'FILE_EDIT_FAILED')
    : 'FILE_EDIT_FAILED'
  throw new AuxiliaryError(code, result.error.message)
}

export const agentEnhancerListInstructionsSkills = {
  async invoke(
    remote: unknown,
    request: ListInstructionsSkillsRequest,
    signal?: AbortSignal,
  ): Promise<InstructionsSkillsSnapshot> {
    const namespace = agentFace(remote)
    const call = Reflect.get(namespace, 'listInstructionsSkills') as ListCall | undefined
    if (typeof call !== 'function') {
      throw new AuxiliaryError('FILE_EDIT_FAILED', 'listInstructionsSkills remote is unavailable')
    }
    let result: RemoteResult<InstructionsSkillsSnapshot>
    try {
      result = await call.apply(namespace, [request, signal])
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new AuxiliaryError('FILE_EDIT_FAILED')
    }
    if (!result.ok) throwRemoteFailure(result)
    return result.value
  },
}

export const agentEnhancerCreateWorkspaceAgents = {
  async invoke(
    remote: unknown,
    request: CreateWorkspaceAgentsRequest,
    signal?: AbortSignal,
  ): Promise<CreateWorkspaceAgentsResult> {
    const namespace = agentFace(remote)
    const call = Reflect.get(namespace, 'createWorkspaceAgents') as CreateAgentsCall | undefined
    if (typeof call !== 'function') {
      throw new AuxiliaryError('FILE_EDIT_FAILED', 'createWorkspaceAgents remote is unavailable')
    }
    let result: RemoteResult<CreateWorkspaceAgentsResult>
    try {
      result = await call.apply(namespace, [request, signal])
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new AuxiliaryError('FILE_EDIT_FAILED')
    }
    if (!result.ok) throwRemoteFailure(result)
    return result.value
  },
}

export const agentEnhancerCreateWorkspaceSkill = {
  async invoke(
    remote: unknown,
    request: CreateWorkspaceSkillRequest,
    signal?: AbortSignal,
  ): Promise<CreateWorkspaceSkillResult> {
    const namespace = agentFace(remote)
    const call = Reflect.get(namespace, 'createWorkspaceSkill') as CreateSkillCall | undefined
    if (typeof call !== 'function') {
      throw new AuxiliaryError('FILE_EDIT_FAILED', 'createWorkspaceSkill remote is unavailable')
    }
    let result: RemoteResult<CreateWorkspaceSkillResult>
    try {
      result = await call.apply(namespace, [request, signal])
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new AuxiliaryError('FILE_EDIT_FAILED')
    }
    if (!result.ok) throwRemoteFailure(result)
    return result.value
  },
}

type InstallGitCall = (
  request: InstallSkillFromGitRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<InstallSkillFromGitResult>>

type UninstallCall = (
  request: UninstallSkillRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<UninstallSkillResult>>

type InstallZipCall = (
  request: InstallSkillFromZipRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<InstallSkillFromZipResult>>

type UpdateSkillFromGitCall = (
  request: UpdateSkillFromGitRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<UpdateSkillFromGitResult>>

type ReadSkillDocumentCall = (
  request: ReadSkillDocumentRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<ReadSkillDocumentResult>>

export const agentEnhancerInstallSkillFromGit = {
  async invoke(
    remote: unknown,
    request: InstallSkillFromGitRequest,
    signal?: AbortSignal,
  ): Promise<InstallSkillFromGitResult> {
    const namespace = agentFace(remote)
    const call = Reflect.get(namespace, 'installSkillFromGit') as InstallGitCall | undefined
    if (typeof call !== 'function') {
      throw new AuxiliaryError('FILE_EDIT_FAILED', 'installSkillFromGit remote is unavailable')
    }
    let result: RemoteResult<InstallSkillFromGitResult>
    try {
      result = await call.apply(namespace, [request, signal])
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new AuxiliaryError('FILE_EDIT_FAILED')
    }
    if (!result.ok) throwRemoteFailure(result)
    return result.value
  },
}

export const agentEnhancerUninstallSkill = {
  async invoke(
    remote: unknown,
    request: UninstallSkillRequest,
    signal?: AbortSignal,
  ): Promise<UninstallSkillResult> {
    const namespace = agentFace(remote)
    const call = Reflect.get(namespace, 'uninstallSkill') as UninstallCall | undefined
    if (typeof call !== 'function') {
      throw new AuxiliaryError('FILE_EDIT_FAILED', 'uninstallSkill remote is unavailable')
    }
    let result: RemoteResult<UninstallSkillResult>
    try {
      result = await call.apply(namespace, [request, signal])
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new AuxiliaryError('FILE_EDIT_FAILED')
    }
    if (!result.ok) throwRemoteFailure(result)
    return result.value
  },
}

export const agentEnhancerUpdateSkillFromGit = {
  async invoke(
    remote: unknown,
    request: UpdateSkillFromGitRequest,
    signal?: AbortSignal,
  ): Promise<UpdateSkillFromGitResult> {
    const namespace = agentFace(remote)
    const call = Reflect.get(namespace, 'updateSkillFromGit') as UpdateSkillFromGitCall | undefined
    if (typeof call !== 'function') {
      throw new AuxiliaryError('FILE_EDIT_FAILED', 'updateSkillFromGit remote is unavailable')
    }
    let result: RemoteResult<UpdateSkillFromGitResult>
    try {
      result = await call.apply(namespace, [request, signal])
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new AuxiliaryError('FILE_EDIT_FAILED')
    }
    if (!result.ok) throwRemoteFailure(result)
    return result.value
  },
}

export const agentEnhancerInstallSkillFromZip = {
  async invoke(
    remote: unknown,
    request: InstallSkillFromZipRequest,
    signal?: AbortSignal,
  ): Promise<InstallSkillFromZipResult> {
    const namespace = agentFace(remote)
    const call = Reflect.get(namespace, 'installSkillFromZip') as InstallZipCall | undefined
    if (typeof call !== 'function') {
      throw new AuxiliaryError('FILE_EDIT_FAILED', 'installSkillFromZip remote is unavailable')
    }
    let result: RemoteResult<InstallSkillFromZipResult>
    try {
      result = await call.apply(namespace, [request, signal])
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new AuxiliaryError('FILE_EDIT_FAILED')
    }
    if (!result.ok) throwRemoteFailure(result)
    return result.value
  },
}

export const agentEnhancerReadSkillDocument = {
  async invoke(
    remote: unknown,
    request: ReadSkillDocumentRequest,
    signal?: AbortSignal,
  ): Promise<ReadSkillDocumentResult> {
    const namespace = agentFace(remote)
    const call = Reflect.get(namespace, 'readSkillDocument') as ReadSkillDocumentCall | undefined
    if (typeof call !== 'function') {
      throw new AuxiliaryError('FILE_EDIT_FAILED', 'readSkillDocument remote is unavailable')
    }
    let result: RemoteResult<ReadSkillDocumentResult>
    try {
      result = await call.apply(namespace, [request, signal])
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new AuxiliaryError('FILE_EDIT_FAILED')
    }
    if (!result.ok) throwRemoteFailure(result)
    return result.value
  },
}
