import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertCodec, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { AuxiliaryError } from '../errors.ts'
import type { RpcPayload } from '../host/rpc.ts'
import type { AuxiliaryResult } from '../host/types.ts'
import { checkpointClientRemoteInfo } from './rollback/remote.ts'

type Call = (payload: RpcPayload, signal?: AbortSignal) => Promise<RemoteResult<AuxiliaryResult | null>>

function codec(typeSymbol: string): TypertCodec {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => { throw new Error('Client Remote schemas are only available on the Host') },
  }
}

const payloadCodec = codec('dsh-agent-enhancer#RpcPayload')

export const clientRemoteInfo = {
  package: 'dsh-agent-enhancer',
  descriptors: [{
    id: 'dsh-agent-enhancer#agentEnhancer/call',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'call',
    implementation: 'call',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'payload',
      wire: 'payload',
      source: 'json',
      codec: payloadCodec,
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#AuxiliaryResult|null'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/listCatalog',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'listCatalog',
    implementation: 'listCatalog',
    invocation: { kind: 'direct' },
    parameters: [],
    result: codec('dsh-agent-enhancer#ModelCatalog'),
  }, ...checkpointClientRemoteInfo.descriptors],
} satisfies TypertRemoteContribution

export const agentEnhancerCall = {
  async invoke(remote: unknown, input: { readonly payload: RpcPayload }, signal?: AbortSignal) {
    const namespace = Reflect.get(remote as object, 'agentEnhancer') as object
    const call = Reflect.get(namespace, 'call') as Call
    let result: RemoteResult<AuxiliaryResult | null>
    try {
      result = await call.apply(namespace, [input.payload, signal])
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new AuxiliaryError('MODEL_FAILED')
    }
    if (!result.ok) {
      const code = result.error.code === 'agent-enhancer/failed' ? result.error.details.code : 'MODEL_FAILED'
      throw new AuxiliaryError(code)
    }
    return result.value
  },
}
