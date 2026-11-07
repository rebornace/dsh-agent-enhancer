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
import type { ApplyUpdateResult, UpdateCheckResult } from '../host/update/types.ts'
import type {
  ProviderBalances,
  ProviderBalancesRequest,
  UsageRange,
  UsageSummary,
} from '../host/usage/types.ts'
import type {
  RpcPayload,
  SoftPauseSetRequest,
  SoftPauseSnapshotRequest,
  SoftPauseState,
} from '../host/rpc.ts'
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
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/deleteSession',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'deleteSession',
    implementation: 'deleteSession',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#DeleteSessionRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#DeleteSessionResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/readWorkspaceFile',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'readWorkspaceFile',
    implementation: 'readWorkspaceFile',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ReadWorkspaceFileRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#ReadWorkspaceFileResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/writeWorkspaceFile',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'writeWorkspaceFile',
    implementation: 'writeWorkspaceFile',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#WriteWorkspaceFileRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#WriteWorkspaceFileResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/listExtraFolders',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'listExtraFolders',
    implementation: 'listExtraFolders',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ListExtraFoldersRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#ListExtraFoldersResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/addExtraFolder',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'addExtraFolder',
    implementation: 'addExtraFolder',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#AddExtraFolderRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#ListExtraFoldersResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/pickExtraFolder',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'pickExtraFolder',
    implementation: 'pickExtraFolder',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#PickExtraFolderRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#PickExtraFolderResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/removeExtraFolder',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'removeExtraFolder',
    implementation: 'removeExtraFolder',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#RemoveExtraFolderRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#ListExtraFoldersResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/listExtraFolderEntries',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'listExtraFolderEntries',
    implementation: 'listExtraFolderEntries',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ListExtraFolderEntriesRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#ListExtraFolderEntriesResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/checkUpdate',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'checkUpdate',
    implementation: 'checkUpdate',
    invocation: { kind: 'direct' },
    parameters: [],
    result: codec('dsh-agent-enhancer#UpdateCheckResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/applyUpdate',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'applyUpdate',
    implementation: 'applyUpdate',
    invocation: { kind: 'direct' },
    parameters: [],
    result: codec('dsh-agent-enhancer#ApplyUpdateResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/usageSummary',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'usageSummary',
    implementation: 'usageSummary',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'range',
      wire: 'range',
      source: 'json',
      codec: codec('dsh-agent-enhancer#UsageRange'),
    }],
    result: codec('dsh-agent-enhancer#UsageSummary'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/providerBalances',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'providerBalances',
    implementation: 'providerBalances',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ProviderBalancesRequest'),
    }],
    result: codec('dsh-agent-enhancer#ProviderBalances'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/softPauseSnapshot',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'softPauseSnapshot',
    implementation: 'softPauseSnapshot',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#SoftPauseSnapshotRequest'),
    }],
    result: codec('dsh-agent-enhancer#SoftPauseState'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/softPauseSet',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'softPauseSet',
    implementation: 'softPauseSet',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#SoftPauseSetRequest'),
    }],
    result: codec('dsh-agent-enhancer#SoftPauseState'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/listInstructionsSkills',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'listInstructionsSkills',
    implementation: 'listInstructionsSkills',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ListInstructionsSkillsRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#InstructionsSkillsSnapshot'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/createWorkspaceAgents',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'createWorkspaceAgents',
    implementation: 'createWorkspaceAgents',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#CreateWorkspaceAgentsRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#CreateWorkspaceAgentsResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/createWorkspaceSkill',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'createWorkspaceSkill',
    implementation: 'createWorkspaceSkill',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#CreateWorkspaceSkillRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#CreateWorkspaceSkillResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/installSkillFromGit',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'installSkillFromGit',
    implementation: 'installSkillFromGit',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#InstallSkillFromGitRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#InstallSkillFromGitResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/uninstallSkill',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'uninstallSkill',
    implementation: 'uninstallSkill',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#UninstallSkillRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#UninstallSkillResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/installSkillFromZip',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'installSkillFromZip',
    implementation: 'installSkillFromZip',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#InstallSkillFromZipRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#InstallSkillFromZipResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/updateSkillFromGit',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'updateSkillFromGit',
    implementation: 'updateSkillFromGit',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#UpdateSkillFromGitRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#UpdateSkillFromGitResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/readSkillDocument',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'readSkillDocument',
    implementation: 'readSkillDocument',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ReadSkillDocumentRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#ReadSkillDocumentResult'),
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

type CheckUpdateCall = () => Promise<RemoteResult<UpdateCheckResult>>

export const agentEnhancerCheckUpdate = {
  async invoke(remote: unknown) {
    if (remote === null || remote === undefined || typeof remote !== 'object') {
      throw new AuxiliaryError('MODEL_FAILED')
    }
    let namespace: object
    try {
      const face = Reflect.get(remote, 'agentEnhancer')
      if (face === null || face === undefined || typeof face !== 'object') {
        throw new AuxiliaryError('MODEL_FAILED')
      }
      namespace = face as object
    } catch (error) {
      if (error instanceof AuxiliaryError) throw error
      throw new AuxiliaryError('MODEL_FAILED')
    }
    const call = Reflect.get(namespace, 'checkUpdate') as CheckUpdateCall | undefined
    if (typeof call !== 'function') throw new AuxiliaryError('MODEL_FAILED')
    let result: RemoteResult<UpdateCheckResult>
    try {
      result = await call.call(namespace)
    } catch {
      throw new AuxiliaryError('MODEL_FAILED')
    }
    if (!result.ok) {
      throw new AuxiliaryError('MODEL_FAILED')
    }
    return result.value
  },
}

type UsageSummaryCall = (range: UsageRange) => Promise<RemoteResult<UsageSummary>>

export const agentEnhancerUsageSummary = {
  async invoke(remote: unknown, range: UsageRange) {
    if (remote === null || remote === undefined || typeof remote !== 'object') {
      throw new AuxiliaryError('MODEL_FAILED')
    }
    let namespace: object
    try {
      const face = Reflect.get(remote, 'agentEnhancer')
      if (face === null || face === undefined || typeof face !== 'object') {
        throw new AuxiliaryError('MODEL_FAILED')
      }
      namespace = face as object
    } catch (error) {
      if (error instanceof AuxiliaryError) throw error
      throw new AuxiliaryError('MODEL_FAILED')
    }
    const call = Reflect.get(namespace, 'usageSummary') as UsageSummaryCall | undefined
    if (typeof call !== 'function') throw new AuxiliaryError('MODEL_FAILED')
    let result: RemoteResult<UsageSummary>
    try {
      result = await call.call(namespace, range)
    } catch {
      throw new AuxiliaryError('MODEL_FAILED')
    }
    if (!result.ok) throw new AuxiliaryError('MODEL_FAILED')
    return result.value
  },
}

type ProviderBalancesCall = (
  request: ProviderBalancesRequest,
) => Promise<RemoteResult<ProviderBalances>>

export const agentEnhancerProviderBalances = {
  async invoke(remote: unknown, request: ProviderBalancesRequest = {}) {
    if (remote === null || remote === undefined || typeof remote !== 'object') {
      throw new AuxiliaryError('MODEL_FAILED')
    }
    let namespace: object
    try {
      const face = Reflect.get(remote, 'agentEnhancer')
      if (face === null || face === undefined || typeof face !== 'object') {
        throw new AuxiliaryError('MODEL_FAILED')
      }
      namespace = face as object
    } catch (error) {
      if (error instanceof AuxiliaryError) throw error
      throw new AuxiliaryError('MODEL_FAILED')
    }
    const call = Reflect.get(namespace, 'providerBalances') as ProviderBalancesCall | undefined
    if (typeof call !== 'function') throw new AuxiliaryError('MODEL_FAILED')
    let result: RemoteResult<ProviderBalances>
    try {
      result = await call.call(namespace, request)
    } catch {
      throw new AuxiliaryError('MODEL_FAILED')
    }
    if (!result.ok) throw new AuxiliaryError('MODEL_FAILED')
    return result.value
  },
}

type SoftPauseSnapshotCall = (
  request: SoftPauseSnapshotRequest,
) => Promise<RemoteResult<SoftPauseState>>

export const agentEnhancerSoftPauseSnapshot = {
  async invoke(remote: unknown, request: SoftPauseSnapshotRequest, signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const namespace = Reflect.get(remote as object, 'agentEnhancer') as object
    const call = Reflect.get(namespace, 'softPauseSnapshot') as SoftPauseSnapshotCall
    let result: RemoteResult<SoftPauseState>
    try {
      result = await call.apply(namespace, [request])
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new AuxiliaryError('MODEL_FAILED')
    }
    if (!result.ok) throw new AuxiliaryError('MODEL_FAILED')
    return result.value
  },
}

type SoftPauseSetCall = (
  request: SoftPauseSetRequest,
) => Promise<RemoteResult<SoftPauseState>>

export const agentEnhancerSoftPauseSet = {
  async invoke(remote: unknown, request: SoftPauseSetRequest, signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const namespace = Reflect.get(remote as object, 'agentEnhancer') as object
    const call = Reflect.get(namespace, 'softPauseSet') as SoftPauseSetCall
    let result: RemoteResult<SoftPauseState>
    try {
      result = await call.apply(namespace, [request])
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new AuxiliaryError('MODEL_FAILED')
    }
    if (!result.ok) throw new AuxiliaryError('MODEL_FAILED')
    return result.value
  },
}

type ApplyUpdateCall = () => Promise<RemoteResult<ApplyUpdateResult>>

export const agentEnhancerApplyUpdate = {
  async invoke(remote: unknown) {
    if (remote === null || remote === undefined || typeof remote !== 'object') {
      throw new AuxiliaryError('MODEL_FAILED')
    }
    let namespace: object
    try {
      const face = Reflect.get(remote, 'agentEnhancer')
      if (face === null || face === undefined || typeof face !== 'object') {
        throw new AuxiliaryError('MODEL_FAILED')
      }
      namespace = face as object
    } catch (error) {
      if (error instanceof AuxiliaryError) throw error
      throw new AuxiliaryError('MODEL_FAILED')
    }
    const call = Reflect.get(namespace, 'applyUpdate') as ApplyUpdateCall | undefined
    if (typeof call !== 'function') throw new AuxiliaryError('MODEL_FAILED')
    let result: RemoteResult<ApplyUpdateResult>
    try {
      result = await call.call(namespace)
    } catch {
      throw new AuxiliaryError('MODEL_FAILED')
    }
    if (!result.ok) {
      throw new AuxiliaryError('MODEL_FAILED')
    }
    return result.value
  },
}
