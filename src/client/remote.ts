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
  BrowserAgentResolveRequest,
  BrowserAgentResolveResult,
  BrowserAgentResolveTabConflictRequest,
  BrowserAgentResolveTabConflictResult,
  BrowserAgentAcknowledgeHumanRequest,
  BrowserAgentAcknowledgeHumanResult,
  BrowserAgentOpenUrlRequest,
  BrowserAgentOpenUrlResult,
  BrowserAgentQuotePageRequest,
  BrowserAgentQuotePageResult,
  BrowserAgentLaunchBrowserRequest,
  BrowserAgentLaunchBrowserResult,
  BrowserAgentSetBrowserRequest,
  BrowserAgentSetBrowserResult,
  BrowserAgentSelectTabRequest,
  BrowserAgentSelectTabResult,
  BrowserAgentSnapshot,
  RpcPayload,
  ShowOsNotificationRequest,
  ShowOsNotificationResult,
  SoftPauseSetRequest,
  SoftPauseSnapshotRequest,
  SoftPauseState,
} from '../host/rpc.ts'
import type { AuxiliaryResult } from '../host/types.ts'
import type { WebChatLoginSnapshot } from '../host/web-chat-bridge/login-snapshot-types.ts'
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
    id: 'dsh-agent-enhancer#agentEnhancer/showOsNotification',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'showOsNotification',
    implementation: 'showOsNotification',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ShowOsNotificationRequest'),
    }],
    result: codec('dsh-agent-enhancer#ShowOsNotificationResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/browserAgentSnapshot',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'browserAgentSnapshot',
    implementation: 'browserAgentSnapshot',
    invocation: { kind: 'direct' },
    parameters: [],
    result: codec('dsh-agent-enhancer#BrowserAgentSnapshot'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/browserAgentResolve',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'browserAgentResolve',
    implementation: 'browserAgentResolve',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#BrowserAgentResolveRequest'),
    }],
    result: codec('dsh-agent-enhancer#BrowserAgentResolveResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/browserAgentResolveTabConflict',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'browserAgentResolveTabConflict',
    implementation: 'browserAgentResolveTabConflict',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#BrowserAgentResolveTabConflictRequest'),
    }],
    result: codec('dsh-agent-enhancer#BrowserAgentResolveTabConflictResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/browserAgentAcknowledgeHuman',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'browserAgentAcknowledgeHuman',
    implementation: 'browserAgentAcknowledgeHuman',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#BrowserAgentAcknowledgeHumanRequest'),
    }],
    result: codec('dsh-agent-enhancer#BrowserAgentAcknowledgeHumanResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/browserAgentOpenUrl',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'browserAgentOpenUrl',
    implementation: 'browserAgentOpenUrl',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#BrowserAgentOpenUrlRequest'),
    }],
    result: codec('dsh-agent-enhancer#BrowserAgentOpenUrlResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/browserAgentQuotePage',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'browserAgentQuotePage',
    implementation: 'browserAgentQuotePage',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#BrowserAgentQuotePageRequest'),
    }],
    result: codec('dsh-agent-enhancer#BrowserAgentQuotePageResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/browserAgentLaunchBrowser',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'browserAgentLaunchBrowser',
    implementation: 'browserAgentLaunchBrowser',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#BrowserAgentLaunchBrowserRequest'),
    }],
    result: codec('dsh-agent-enhancer#BrowserAgentLaunchBrowserResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/browserAgentSetBrowser',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'browserAgentSetBrowser',
    implementation: 'browserAgentSetBrowser',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#BrowserAgentSetBrowserRequest'),
    }],
    result: codec('dsh-agent-enhancer#BrowserAgentSetBrowserResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/browserAgentSelectTab',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'browserAgentSelectTab',
    implementation: 'browserAgentSelectTab',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#BrowserAgentSelectTabRequest'),
    }],
    result: codec('dsh-agent-enhancer#BrowserAgentSelectTabResult'),
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
  },   {
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
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/getSkillInstallProgress',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'getSkillInstallProgress',
    implementation: 'getSkillInstallProgress',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#GetSkillInstallProgressRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#GetSkillInstallProgressResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/listMcpConnectors',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'listMcpConnectors',
    implementation: 'listMcpConnectors',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ListMcpConnectorsRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#McpConnectorsSnapshot'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/upsertMcpConnector',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'upsertMcpConnector',
    implementation: 'upsertMcpConnector',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#UpsertMcpConnectorRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#UpsertMcpConnectorResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/setMcpConnectorEnabled',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'setMcpConnectorEnabled',
    implementation: 'setMcpConnectorEnabled',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#SetMcpConnectorEnabledRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#SetMcpConnectorEnabledResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/uninstallMcpConnector',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'uninstallMcpConnector',
    implementation: 'uninstallMcpConnector',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#UninstallMcpConnectorRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#UninstallMcpConnectorResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/installMcpFromNpx',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'installMcpFromNpx',
    implementation: 'installMcpFromNpx',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#InstallMcpFromNpxRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#InstallMcpFromNpxResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/installMcpFromGit',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'installMcpFromGit',
    implementation: 'installMcpFromGit',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#InstallMcpFromGitRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#InstallMcpFromGitResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/importMcpJson',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'importMcpJson',
    implementation: 'importMcpJson',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ImportMcpJsonRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#ImportMcpJsonResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/listMcpConnectorTools',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'listMcpConnectorTools',
    implementation: 'listMcpConnectorTools',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ListMcpConnectorToolsRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#ListMcpConnectorToolsResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/restartMcpConnector',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'restartMcpConnector',
    implementation: 'restartMcpConnector',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#RestartMcpConnectorRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#RestartMcpConnectorResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/probeMcpConnector',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'probeMcpConnector',
    implementation: 'probeMcpConnector',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ProbeMcpConnectorRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#ProbeMcpConnectorResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/listWebChatWorkspaces',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'listWebChatWorkspaces',
    implementation: 'listWebChatWorkspaces',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ListWebChatWorkspacesRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#ListWebChatWorkspacesResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/createWebChatWorkspace',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'createWebChatWorkspace',
    implementation: 'createWebChatWorkspace',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#CreateWebChatWorkspaceRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#CreateWebChatWorkspaceResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/importWebChatHistory',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'importWebChatHistory',
    implementation: 'importWebChatHistory',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ImportWebChatHistoryRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#ImportWebChatHistoryResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/parseWebChatExport',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'parseWebChatExport',
    implementation: 'parseWebChatExport',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ParseWebChatExportRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#ParseWebChatExportResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/resolveWebChatShareLink',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'resolveWebChatShareLink',
    implementation: 'resolveWebChatShareLink',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ResolveWebChatShareLinkRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#ResolveWebChatShareLinkResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/loadWebChatLoginSnapshot',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'loadWebChatLoginSnapshot',
    implementation: 'loadWebChatLoginSnapshot',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#LoadWebChatLoginSnapshotRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#LoadWebChatLoginSnapshotResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/saveWebChatLoginSnapshot',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'saveWebChatLoginSnapshot',
    implementation: 'saveWebChatLoginSnapshot',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#SaveWebChatLoginSnapshotRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#SaveWebChatLoginSnapshotResult'),
  }, {
    id: 'dsh-agent-enhancer#agentEnhancer/clearWebChatLoginSnapshot',
    service: 'agentEnhancer',
    namespace: 'agentEnhancer',
    method: 'clearWebChatLoginSnapshot',
    implementation: 'clearWebChatLoginSnapshot',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec('dsh-agent-enhancer#ClearWebChatLoginSnapshotRequest'),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('dsh-agent-enhancer#ClearWebChatLoginSnapshotResult'),
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

type ShowOsNotificationCall = (
  request: ShowOsNotificationRequest,
) => Promise<RemoteResult<ShowOsNotificationResult>>

export const agentEnhancerShowOsNotification = {
  async invoke(remote: unknown, request: ShowOsNotificationRequest, signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (remote === null || remote === undefined || typeof remote !== 'object') {
      return { shown: false, channel: 'none' as const }
    }
    const namespace = Reflect.get(remote, 'agentEnhancer') as object | undefined
    if (namespace === undefined || typeof namespace !== 'object') {
      return { shown: false, channel: 'none' as const }
    }
    const call = Reflect.get(namespace, 'showOsNotification') as ShowOsNotificationCall | undefined
    if (typeof call !== 'function') return { shown: false, channel: 'none' as const }
    try {
      const result = await call.apply(namespace, [request])
      if (!result.ok) return { shown: false, channel: 'none' as const }
      return result.value
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      return { shown: false, channel: 'none' as const }
    }
  },
}

type BrowserAgentSnapshotCall = () => Promise<RemoteResult<BrowserAgentSnapshot>>
type BrowserAgentResolveCall = (
  request: BrowserAgentResolveRequest,
) => Promise<RemoteResult<BrowserAgentResolveResult>>
type BrowserAgentResolveTabConflictCall = (
  request: BrowserAgentResolveTabConflictRequest,
) => Promise<RemoteResult<BrowserAgentResolveTabConflictResult>>
type BrowserAgentAcknowledgeHumanCall = (
  request: BrowserAgentAcknowledgeHumanRequest,
) => Promise<RemoteResult<BrowserAgentAcknowledgeHumanResult>>
type BrowserAgentOpenUrlCall = (
  request: BrowserAgentOpenUrlRequest,
) => Promise<RemoteResult<BrowserAgentOpenUrlResult>>
type BrowserAgentQuotePageCall = (
  request: BrowserAgentQuotePageRequest,
) => Promise<RemoteResult<BrowserAgentQuotePageResult>>

function emptyBrowserAgentSnapshot(): BrowserAgentSnapshot {
  return {
    enabled: false,
    browser: 'auto',
    launchedBrowser: null,
    driver: 'playwright',
    allowedOrigins: [],
    bridge: { listening: false, extensionConnected: false, port: 0, lastError: null },
    pending: null,
    tabConflict: null,
    needsHuman: null,
    boundTabId: null,
    tabs: [],
    audit: [],
    profileDir: 'browser-agent/profile-auto',
  }
}

export const agentEnhancerBrowserAgentSnapshot = {
  async invoke(remote: unknown, signal?: AbortSignal): Promise<BrowserAgentSnapshot> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const empty = emptyBrowserAgentSnapshot()
    if (remote === null || remote === undefined || typeof remote !== 'object') return empty
    const namespace = Reflect.get(remote, 'agentEnhancer') as object | undefined
    if (namespace === undefined || typeof namespace !== 'object') return empty
    const call = Reflect.get(namespace, 'browserAgentSnapshot') as BrowserAgentSnapshotCall | undefined
    if (typeof call !== 'function') return empty
    try {
      const result = await call.apply(namespace, [])
      if (!result.ok) return empty
      return result.value
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      return empty
    }
  },
}

export const agentEnhancerBrowserAgentResolve = {
  async invoke(
    remote: unknown,
    request: BrowserAgentResolveRequest,
    signal?: AbortSignal,
  ): Promise<BrowserAgentResolveResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const empty: BrowserAgentResolveResult = {
      ok: false,
      snapshot: emptyBrowserAgentSnapshot(),
    }
    if (remote === null || remote === undefined || typeof remote !== 'object') return empty
    const namespace = Reflect.get(remote, 'agentEnhancer') as object | undefined
    if (namespace === undefined || typeof namespace !== 'object') return empty
    const call = Reflect.get(namespace, 'browserAgentResolve') as BrowserAgentResolveCall | undefined
    if (typeof call !== 'function') return empty
    try {
      const result = await call.apply(namespace, [request])
      if (!result.ok) return empty
      return result.value
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      return empty
    }
  },
}

export const agentEnhancerBrowserAgentResolveTabConflict = {
  async invoke(
    remote: unknown,
    request: BrowserAgentResolveTabConflictRequest,
    signal?: AbortSignal,
  ): Promise<BrowserAgentResolveTabConflictResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const empty: BrowserAgentResolveTabConflictResult = {
      ok: false,
      snapshot: emptyBrowserAgentSnapshot(),
    }
    if (remote === null || remote === undefined || typeof remote !== 'object') return empty
    const namespace = Reflect.get(remote, 'agentEnhancer') as object | undefined
    if (namespace === undefined || typeof namespace !== 'object') return empty
    const call = Reflect.get(namespace, 'browserAgentResolveTabConflict') as BrowserAgentResolveTabConflictCall | undefined
    if (typeof call !== 'function') return empty
    try {
      const result = await call.apply(namespace, [request])
      if (!result.ok) return empty
      return result.value
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      return empty
    }
  },
}

export const agentEnhancerBrowserAgentAcknowledgeHuman = {
  async invoke(
    remote: unknown,
    request: BrowserAgentAcknowledgeHumanRequest = {},
    signal?: AbortSignal,
  ): Promise<BrowserAgentAcknowledgeHumanResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const empty: BrowserAgentAcknowledgeHumanResult = {
      ok: false,
      snapshot: emptyBrowserAgentSnapshot(),
    }
    if (remote === null || remote === undefined || typeof remote !== 'object') return empty
    const namespace = Reflect.get(remote, 'agentEnhancer') as object | undefined
    if (namespace === undefined || typeof namespace !== 'object') return empty
    const call = Reflect.get(namespace, 'browserAgentAcknowledgeHuman') as BrowserAgentAcknowledgeHumanCall | undefined
    if (typeof call !== 'function') return empty
    try {
      const result = await call.apply(namespace, [request])
      if (!result.ok) return empty
      return result.value
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      return empty
    }
  },
}

export const agentEnhancerBrowserAgentOpenUrl = {
  async invoke(
    remote: unknown,
    request: BrowserAgentOpenUrlRequest,
    signal?: AbortSignal,
  ): Promise<BrowserAgentOpenUrlResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const empty: BrowserAgentOpenUrlResult = {
      ok: false,
      snapshot: emptyBrowserAgentSnapshot(),
    }
    if (remote === null || remote === undefined || typeof remote !== 'object') return empty
    const namespace = Reflect.get(remote, 'agentEnhancer') as object | undefined
    if (namespace === undefined || typeof namespace !== 'object') return empty
    const call = Reflect.get(namespace, 'browserAgentOpenUrl') as BrowserAgentOpenUrlCall | undefined
    if (typeof call !== 'function') return empty
    try {
      const result = await call.apply(namespace, [request])
      if (!result.ok) return empty
      return result.value
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      return empty
    }
  },
}

export const agentEnhancerBrowserAgentQuotePage = {
  async invoke(
    remote: unknown,
    request: BrowserAgentQuotePageRequest,
    signal?: AbortSignal,
  ): Promise<BrowserAgentQuotePageResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const empty: BrowserAgentQuotePageResult = {
      ok: false,
      snapshot: emptyBrowserAgentSnapshot(),
    }
    if (remote === null || remote === undefined || typeof remote !== 'object') return empty
    const namespace = Reflect.get(remote, 'agentEnhancer') as object | undefined
    if (namespace === undefined || typeof namespace !== 'object') return empty
    const call = Reflect.get(namespace, 'browserAgentQuotePage') as BrowserAgentQuotePageCall | undefined
    if (typeof call !== 'function') return empty
    try {
      const result = await call.apply(namespace, [request])
      if (!result.ok) return empty
      return result.value
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      return empty
    }
  },
}

type BrowserAgentLaunchBrowserCall = (
  request: BrowserAgentLaunchBrowserRequest,
) => Promise<RemoteResult<BrowserAgentLaunchBrowserResult>>

export const agentEnhancerBrowserAgentLaunchBrowser = {
  async invoke(
    remote: unknown,
    request: BrowserAgentLaunchBrowserRequest = {},
    signal?: AbortSignal,
  ): Promise<BrowserAgentLaunchBrowserResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const empty = (error: string): BrowserAgentLaunchBrowserResult => ({
      ok: false,
      profileDir: emptyBrowserAgentSnapshot().profileDir,
      error,
      snapshot: emptyBrowserAgentSnapshot(),
    })
    if (remote === null || remote === undefined || typeof remote !== 'object') {
      return empty('Host remote unavailable')
    }
    const namespace = Reflect.get(remote, 'agentEnhancer') as object | undefined
    if (namespace === undefined || typeof namespace !== 'object') {
      return empty('agentEnhancer remote missing — reload the plugin')
    }
    const call = Reflect.get(namespace, 'browserAgentLaunchBrowser') as BrowserAgentLaunchBrowserCall | undefined
    if (typeof call !== 'function') {
      return empty('browserAgentLaunchBrowser missing — reload Desktop / reinstall the plugin')
    }
    try {
      const result = await call.apply(namespace, [request])
      if (!result.ok) {
        const message = typeof (result as { error?: { message?: string } }).error?.message === 'string'
          ? (result as { error: { message: string } }).error.message
          : 'Launch RPC failed'
        return empty(message)
      }
      return result.value
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      return empty(error instanceof Error ? error.message : String(error))
    }
  },
}

type BrowserAgentSetBrowserCall = (
  request: BrowserAgentSetBrowserRequest,
) => Promise<RemoteResult<BrowserAgentSetBrowserResult>>

export const agentEnhancerBrowserAgentSetBrowser = {
  async invoke(
    remote: unknown,
    request: BrowserAgentSetBrowserRequest,
    signal?: AbortSignal,
  ): Promise<BrowserAgentSetBrowserResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const empty = (browser: BrowserAgentSetBrowserRequest['browser']): BrowserAgentSetBrowserResult => ({
      ok: false,
      browser,
      snapshot: emptyBrowserAgentSnapshot(),
    })
    if (remote === null || remote === undefined || typeof remote !== 'object') {
      return empty(request.browser)
    }
    const namespace = Reflect.get(remote, 'agentEnhancer') as object | undefined
    if (namespace === undefined || typeof namespace !== 'object') {
      return empty(request.browser)
    }
    const call = Reflect.get(namespace, 'browserAgentSetBrowser') as BrowserAgentSetBrowserCall | undefined
    if (typeof call !== 'function') {
      return empty(request.browser)
    }
    try {
      const result = await call.apply(namespace, [request])
      if (!result.ok) return empty(request.browser)
      return result.value
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      return empty(request.browser)
    }
  },
}

type BrowserAgentSelectTabCall = (
  request: BrowserAgentSelectTabRequest,
) => Promise<RemoteResult<BrowserAgentSelectTabResult>>

export const agentEnhancerBrowserAgentSelectTab = {
  async invoke(
    remote: unknown,
    request: BrowserAgentSelectTabRequest,
    signal?: AbortSignal,
  ): Promise<BrowserAgentSelectTabResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const empty = (error: string): BrowserAgentSelectTabResult => ({
      ok: false,
      error,
      snapshot: emptyBrowserAgentSnapshot(),
    })
    if (remote === null || remote === undefined || typeof remote !== 'object') {
      return empty('Host remote unavailable')
    }
    const namespace = Reflect.get(remote, 'agentEnhancer') as object | undefined
    if (namespace === undefined || typeof namespace !== 'object') {
      return empty('agentEnhancer remote missing — reload the plugin')
    }
    const call = Reflect.get(namespace, 'browserAgentSelectTab') as BrowserAgentSelectTabCall | undefined
    if (typeof call !== 'function') {
      return empty('browserAgentSelectTab missing — reload Desktop / reinstall the plugin')
    }
    try {
      const result = await call.apply(namespace, [request])
      if (!result.ok) {
        const message = typeof (result as { error?: { message?: string } }).error?.message === 'string'
          ? (result as { error: { message: string } }).error.message
          : 'Select tab RPC failed'
        return empty(message)
      }
      return result.value
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      return empty(error instanceof Error ? error.message : String(error))
    }
  },
}

type WebChatLoginRemoteSource = () => { readonly agentEnhancer: object } | undefined

type LoadWebChatLoginCall = (
  request: Record<string, never>,
  signal?: AbortSignal,
) => Promise<RemoteResult<{ snapshot: WebChatLoginSnapshot | null }>>

export const agentEnhancerLoadWebChatLogin = {
  async invoke(
    remoteSource: WebChatLoginRemoteSource,
    signal?: AbortSignal,
  ): Promise<{ snapshot: WebChatLoginSnapshot | null }> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const empty = { snapshot: null }
    const remote = remoteSource()
    if (remote === undefined) return empty
    const namespace = remote.agentEnhancer
    if (typeof namespace !== 'object') return empty
    const call = Reflect.get(namespace, 'loadWebChatLoginSnapshot') as LoadWebChatLoginCall | undefined
    if (typeof call !== 'function') return empty
    const result = await call.apply(namespace, [{} as Record<string, never>, signal])
    if (!result.ok) return empty
    return result.value
  },
}

type SaveWebChatLoginCall = (
  request: {
    readonly localStorage: Readonly<Record<string, string>>
    readonly cookie: string
    readonly savedAt: string
  },
  signal?: AbortSignal,
) => Promise<RemoteResult<{ ok: true }>>

export const agentEnhancerSaveWebChatLogin = {
  async invoke(
    remoteSource: WebChatLoginRemoteSource,
    request: {
      readonly localStorage: Readonly<Record<string, string>>
      readonly cookie: string
      readonly savedAt: string
    },
    signal?: AbortSignal,
  ): Promise<{ ok: true }> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const remote = remoteSource()
    if (remote === undefined) return { ok: true }
    const namespace = remote.agentEnhancer
    if (typeof namespace !== 'object') return { ok: true }
    const call = Reflect.get(namespace, 'saveWebChatLoginSnapshot') as SaveWebChatLoginCall | undefined
    if (typeof call !== 'function') return { ok: true }
    const result = await call.apply(namespace, [request, signal])
    if (!result.ok) return { ok: true }
    return result.value
  },
}

type ClearWebChatLoginCall = (
  request: Record<string, never>,
  signal?: AbortSignal,
) => Promise<RemoteResult<{ cleared: boolean }>>

export const agentEnhancerClearWebChatLogin = {
  async invoke(
    remoteSource: WebChatLoginRemoteSource,
    signal?: AbortSignal,
  ): Promise<{ cleared: boolean }> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const empty = { cleared: false }
    const remote = remoteSource()
    if (remote === undefined) return empty
    const namespace = remote.agentEnhancer
    if (typeof namespace !== 'object') return empty
    const call = Reflect.get(namespace, 'clearWebChatLoginSnapshot') as ClearWebChatLoginCall | undefined
    if (typeof call !== 'function') return empty
    const result = await call.apply(namespace, [{} as Record<string, never>, signal])
    if (!result.ok) return empty
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
