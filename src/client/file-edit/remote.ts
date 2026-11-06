import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { AUXILIARY_ERROR_CODES, AuxiliaryError } from '../../errors.ts'
import type { AuxiliaryErrorCode } from '../../errors.ts'
import type {
  ReadWorkspaceFileRequest,
  ReadWorkspaceFileResult,
  WriteWorkspaceFileRequest,
  WriteWorkspaceFileResult,
} from '../../host/file-edit/types.ts'

function auxiliaryCode(value: unknown, fallback: AuxiliaryErrorCode): AuxiliaryErrorCode {
  return typeof value === 'string' && (AUXILIARY_ERROR_CODES as readonly string[]).includes(value)
    ? value as AuxiliaryErrorCode
    : fallback
}

type ReadCall = (
  request: ReadWorkspaceFileRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<ReadWorkspaceFileResult>>

type WriteCall = (
  request: WriteWorkspaceFileRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<WriteWorkspaceFileResult>>

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

export const agentEnhancerReadWorkspaceFile = {
  async invoke(remote: unknown, request: ReadWorkspaceFileRequest, signal?: AbortSignal) {
    const namespace = agentFace(remote)
    const call = Reflect.get(namespace, 'readWorkspaceFile') as ReadCall | undefined
    if (typeof call !== 'function') {
      throw new AuxiliaryError('FILE_EDIT_FAILED', 'readWorkspaceFile remote is unavailable')
    }
    let result: RemoteResult<ReadWorkspaceFileResult>
    try {
      result = await call.apply(namespace, [request, signal])
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new AuxiliaryError('FILE_EDIT_FAILED')
    }
    if (!result.ok) {
      const code = result.error.code === 'agent-enhancer/failed'
        ? auxiliaryCode(result.error.details.code, 'FILE_EDIT_FAILED')
        : 'FILE_EDIT_FAILED'
      throw new AuxiliaryError(code, result.error.message)
    }
    return result.value
  },
}

export const agentEnhancerWriteWorkspaceFile = {
  async invoke(remote: unknown, request: WriteWorkspaceFileRequest, signal?: AbortSignal) {
    const namespace = agentFace(remote)
    const call = Reflect.get(namespace, 'writeWorkspaceFile') as WriteCall | undefined
    if (typeof call !== 'function') {
      throw new AuxiliaryError('FILE_EDIT_FAILED', 'writeWorkspaceFile remote is unavailable')
    }
    let result: RemoteResult<WriteWorkspaceFileResult>
    try {
      result = await call.apply(namespace, [request, signal])
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new AuxiliaryError('FILE_EDIT_FAILED')
    }
    if (!result.ok) {
      const code = result.error.code === 'agent-enhancer/failed'
        ? auxiliaryCode(result.error.details.code, 'FILE_EDIT_FAILED')
        : 'FILE_EDIT_FAILED'
      throw new AuxiliaryError(code, result.error.message)
    }
    return result.value
  },
}
