import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { AUXILIARY_ERROR_CODES, AuxiliaryError } from '../../errors.ts'
import type { AuxiliaryErrorCode } from '../../errors.ts'
import type {
  AddExtraFolderRequest,
  ListExtraFolderEntriesRequest,
  ListExtraFolderEntriesResult,
  ListExtraFoldersRequest,
  ListExtraFoldersResult,
  PickExtraFolderRequest,
  PickExtraFolderResult,
  RemoveExtraFolderRequest,
} from '../../host/extra-folders/types.ts'

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
  request: ListExtraFoldersRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<ListExtraFoldersResult>>

type MutateCall = (
  request: AddExtraFolderRequest | RemoveExtraFolderRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<ListExtraFoldersResult>>

type EntriesCall = (
  request: ListExtraFolderEntriesRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<ListExtraFolderEntriesResult>>

type PickCall = (
  request: PickExtraFolderRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<PickExtraFolderResult>>

async function invokeListish(
  remote: unknown,
  method: 'listExtraFolders' | 'addExtraFolder' | 'removeExtraFolder',
  request: ListExtraFoldersRequest | AddExtraFolderRequest | RemoveExtraFolderRequest,
  signal?: AbortSignal,
): Promise<ListExtraFoldersResult> {
  const namespace = agentFace(remote)
  const call = Reflect.get(namespace, method) as ListCall | MutateCall | undefined
  if (typeof call !== 'function') {
    throw new AuxiliaryError('FILE_EDIT_FAILED', `${method} remote is unavailable`)
  }
  let result: RemoteResult<ListExtraFoldersResult>
  try {
    result = await (call as MutateCall).apply(namespace, [request as AddExtraFolderRequest, signal])
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
}

export const agentEnhancerListExtraFolders = {
  invoke(remote: unknown, request: ListExtraFoldersRequest, signal?: AbortSignal) {
    return invokeListish(remote, 'listExtraFolders', request, signal)
  },
}

export const agentEnhancerAddExtraFolder = {
  invoke(remote: unknown, request: AddExtraFolderRequest, signal?: AbortSignal) {
    return invokeListish(remote, 'addExtraFolder', request, signal)
  },
}

export const agentEnhancerPickExtraFolder = {
  async invoke(remote: unknown, request: PickExtraFolderRequest, signal?: AbortSignal) {
    const namespace = agentFace(remote)
    const call = Reflect.get(namespace, 'pickExtraFolder') as PickCall | undefined
    if (typeof call !== 'function') {
      throw new AuxiliaryError('FILE_EDIT_FAILED', 'pickExtraFolder remote is unavailable')
    }
    let result: RemoteResult<PickExtraFolderResult>
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

export const agentEnhancerRemoveExtraFolder = {
  invoke(remote: unknown, request: RemoveExtraFolderRequest, signal?: AbortSignal) {
    return invokeListish(remote, 'removeExtraFolder', request, signal)
  },
}

export const agentEnhancerListExtraFolderEntries = {
  async invoke(remote: unknown, request: ListExtraFolderEntriesRequest, signal?: AbortSignal) {
    const namespace = agentFace(remote)
    const call = Reflect.get(namespace, 'listExtraFolderEntries') as EntriesCall | undefined
    if (typeof call !== 'function') {
      throw new AuxiliaryError('FILE_EDIT_FAILED', 'listExtraFolderEntries remote is unavailable')
    }
    let result: RemoteResult<ListExtraFolderEntriesResult>
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
