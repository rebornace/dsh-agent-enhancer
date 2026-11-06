import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AuxiliaryError } from '../../errors.ts'
import type { AuxiliaryErrorCode } from '../../errors.ts'
import type { DeleteSessionRequest, DeleteSessionResult } from '../../host/session-delete/delete.ts'

type RemoteResult<T> =
  | { readonly ok: true, readonly value: T }
  | {
    readonly ok: false
    readonly error: {
      readonly code: string
      readonly message?: string
      readonly details?: { readonly code?: string, readonly message?: string }
    }
  }

function auxiliaryCode(code: string | undefined, fallback: AuxiliaryErrorCode): AuxiliaryErrorCode {
  if (code === undefined) return fallback
  const known = [
    'SESSION_BUSY', 'SESSION_DELETE_FAILED', 'SESSION_CHANGED', 'MODEL_FAILED',
  ] as const satisfies readonly AuxiliaryErrorCode[]
  for (const entry of known) {
    if (entry === code) return entry
  }
  return fallback
}

function remoteMessage(error: {
  readonly message?: string
  readonly details?: { readonly message?: string }
}): string | undefined {
  if (typeof error.message === 'string' && error.message.trim() !== '') return error.message.trim()
  if (typeof error.details?.message === 'string' && error.details.message.trim() !== '') {
    return error.details.message.trim()
  }
  return undefined
}

type DeleteCall = (
  request: DeleteSessionRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<DeleteSessionResult>>

export const agentEnhancerDeleteSession = {
  async invoke(remote: unknown, sessionId: SessionId, signal?: AbortSignal) {
    if (remote === undefined || remote === null || typeof remote !== 'object') {
      throw new AuxiliaryError('SESSION_DELETE_FAILED', 'remote is not ready')
    }
    const namespace = Reflect.get(remote, 'agentEnhancer') as object | undefined
    if (namespace === undefined || namespace === null || typeof namespace !== 'object') {
      throw new AuxiliaryError('SESSION_DELETE_FAILED', 'agentEnhancer remote is unavailable')
    }
    const call = Reflect.get(namespace, 'deleteSession') as DeleteCall | undefined
    if (typeof call !== 'function') {
      throw new AuxiliaryError('SESSION_DELETE_FAILED', 'deleteSession remote is unavailable')
    }
    let result: RemoteResult<DeleteSessionResult>
    try {
      result = await call.apply(namespace, [{ sessionId }, signal])
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new AuxiliaryError(
        'SESSION_DELETE_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    }
    if (!result.ok) {
      const code = result.error.code === 'agent-enhancer/failed'
        ? auxiliaryCode(result.error.details?.code, 'SESSION_DELETE_FAILED')
        : 'SESSION_DELETE_FAILED'
      throw new AuxiliaryError(code, remoteMessage(result.error))
    }
    return result.value
  },
}
