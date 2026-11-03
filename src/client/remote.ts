import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertCodec, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { AUXILIARY_ERROR_CODES, AuxiliaryError } from '../errors.ts'
import type { AuxiliaryErrorCode } from '../errors.ts'

function auxiliaryCode(value: unknown, fallback: AuxiliaryErrorCode): AuxiliaryErrorCode {
  return typeof value === 'string' && (AUXILIARY_ERROR_CODES as readonly string[]).includes(value)
    ? value as AuxiliaryErrorCode
    : fallback
}
import type { ContextCompactRequest, ContextCompactResult } from '../host/context-compact.ts'
import type { ContextInspectRequest, ContextInspectResult } from '../host/context-inspect.ts'
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
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/inspectContext',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'inspectContext',
    implementation: 'inspectContext',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ContextInspectRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#ContextInspectResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/compactContext',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'compactContext',
    implementation: 'compactContext',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ContextCompactRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#ContextCompactResult'),
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
      const code = result.error.code === 'agent-enhancer/failed'
        ? auxiliaryCode(result.error.details.code, 'MODEL_FAILED')
        : 'MODEL_FAILED'
      throw new AuxiliaryError(code)
    }
    return result.value
  },
}

type InspectCall = (
  request: ContextInspectRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<ContextInspectResult>>

export const agentEnhancerInspectContext = {
  async invoke(remote: unknown, request: ContextInspectRequest, signal?: AbortSignal) {
    const namespace = Reflect.get(remote as object, 'agentEnhancer') as object
    const call = Reflect.get(namespace, 'inspectContext') as InspectCall
    let result: RemoteResult<ContextInspectResult>
    try {
      result = await call.apply(namespace, [request, signal])
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new AuxiliaryError('MODEL_FAILED')
    }
    if (!result.ok) {
      const code = result.error.code === 'agent-enhancer/failed'
        ? auxiliaryCode(result.error.details.code, 'MODEL_FAILED')
        : 'MODEL_FAILED'
      throw new AuxiliaryError(code)
    }
    return result.value
  },
}

type CompactCall = (
  request: ContextCompactRequest,
  signal?: AbortSignal,
) => Promise<RemoteResult<ContextCompactResult>>

export const agentEnhancerCompactContext = {
  async invoke(remote: unknown, request: ContextCompactRequest, signal?: AbortSignal) {
    const namespace = Reflect.get(remote as object, 'agentEnhancer') as object
    const call = Reflect.get(namespace, 'compactContext') as CompactCall
    let result: RemoteResult<ContextCompactResult>
    try {
      result = await call.apply(namespace, [request, signal])
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new AuxiliaryError('COMPACT_FAILED')
    }
    if (!result.ok) {
      const code = result.error.code === 'agent-enhancer/failed'
        ? auxiliaryCode(result.error.details.code, 'COMPACT_FAILED')
        : 'COMPACT_FAILED'
      throw new AuxiliaryError(code)
    }
    return result.value
  },
}
