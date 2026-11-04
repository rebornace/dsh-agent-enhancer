import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertCodec, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {
  CheckpointRollbackErrorCode,
  CheckpointRollbackPreview,
  CheckpointRollbackRequest,
  CheckpointRollbackResult,
  CheckpointSummariesRequest,
  CheckpointSummariesResult,
} from '../../host/checkpoint/service.ts'

function codec(typeSymbol: string): TypertCodec {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => { throw new Error('Client Remote schemas are only available on the Host') },
  }
}

const requestCodec = codec('dsh-agent-enhancer#CheckpointRollbackRequest')
const summariesRequestCodec = codec('dsh-agent-enhancer#CheckpointSummariesRequest')

export const checkpointClientRemoteInfo = {
  package: 'dsh-agent-enhancer',
  descriptors: [{
    id: 'dsh-agent-enhancer#checkpointRollback/preview',
    service: 'checkpointRollback',
    namespace: 'checkpointRollback',
    method: 'preview',
    implementation: 'preview',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: requestCodec }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#CheckpointRollbackPreview'),
  }, {
    id: 'dsh-agent-enhancer#checkpointRollback/execute',
    service: 'checkpointRollback',
    namespace: 'checkpointRollback',
    method: 'execute',
    implementation: 'execute',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: requestCodec }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#CheckpointRollbackResult'),
  }, {
    id: 'dsh-agent-enhancer#checkpointRollback/summaries',
    service: 'checkpointRollback',
    namespace: 'checkpointRollback',
    method: 'summaries',
    implementation: 'summaries',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: summariesRequestCodec }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#CheckpointSummariesResult'),
  }],
} satisfies TypertRemoteContribution

export class CheckpointRollbackClientError extends Error {
  constructor(readonly code: CheckpointRollbackErrorCode) {
    super(code)
    this.name = 'CheckpointRollbackClientError'
  }
}

type Call = (
  request: CheckpointRollbackRequest | CheckpointSummariesRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<unknown>>

async function invoke(
  remote: unknown,
  method: 'preview' | 'execute' | 'summaries',
  request: CheckpointRollbackRequest | CheckpointSummariesRequest,
  signal?: AbortSignal,
) {
  const namespace = Reflect.get(remote as object, 'checkpointRollback') as object
  const call = Reflect.get(namespace, method) as Call
  let result: RemoteResult<unknown>
  try {
    result = await call.apply(namespace, [request, signal])
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
    throw new CheckpointRollbackClientError('ROLLBACK_FAILED')
  }
  if (!result.ok) {
    const code = result.error.code === 'agent-enhancer/rollback-failed'
      ? result.error.details.code : 'ROLLBACK_FAILED'
    throw new CheckpointRollbackClientError(code)
  }
  return result.value
}

export const checkpointRollbackRemote = {
  preview(remote: unknown, request: CheckpointRollbackRequest, signal?: AbortSignal) {
    return invoke(remote, 'preview', request, signal) as Promise<CheckpointRollbackPreview>
  },
  execute(remote: unknown, request: CheckpointRollbackRequest, signal?: AbortSignal) {
    return invoke(remote, 'execute', request, signal) as Promise<CheckpointRollbackResult>
  },
  summaries(remote: unknown, request: CheckpointSummariesRequest, signal?: AbortSignal) {
    return invoke(remote, 'summaries', request, signal) as Promise<CheckpointSummariesResult>
  },
}
