import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { AUXILIARY_ERROR_CODES, AuxiliaryError } from '../../errors.ts'
import type { AuxiliaryErrorCode } from '../../errors.ts'
import type {
  ImportMcpJsonRequest,
  ImportMcpJsonResult,
  InstallMcpFromGitRequest,
  InstallMcpFromGitResult,
  InstallMcpFromNpxRequest,
  InstallMcpFromNpxResult,
  ListMcpConnectorToolsRequest,
  ListMcpConnectorToolsResult,
  McpConnectorsSnapshot,
  ProbeMcpConnectorRequest,
  ProbeMcpConnectorResult,
  RestartMcpConnectorRequest,
  RestartMcpConnectorResult,
  SetMcpConnectorEnabledRequest,
  SetMcpConnectorEnabledResult,
  UninstallMcpConnectorRequest,
  UninstallMcpConnectorResult,
  UpsertMcpConnectorRequest,
  UpsertMcpConnectorResult,
} from '../../host/mcp-connectors/types.ts'

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

function throwRemoteFailure(result: Extract<RemoteResult<unknown>, { readonly ok: false }>): never {
  const code = result.error.code === 'agent-enhancer/failed'
    ? auxiliaryCode(result.error.details.code, 'FILE_EDIT_FAILED')
    : 'FILE_EDIT_FAILED'
  throw new AuxiliaryError(code, result.error.message)
}

async function callFace<T>(
  remote: unknown,
  method: string,
  request: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const namespace = agentFace(remote)
  const call = Reflect.get(namespace, method) as
    | ((req: unknown, signal?: AbortSignal) => Promise<RemoteResult<T>>)
    | undefined
  if (typeof call !== 'function') {
    throw new AuxiliaryError('FILE_EDIT_FAILED', `${method} remote is unavailable`)
  }
  let result: RemoteResult<T>
  try {
    result = await call.apply(namespace, [request, signal])
  } catch (error) {
    if (error instanceof AuxiliaryError) throw error
    throw new AuxiliaryError('FILE_EDIT_FAILED', `${method} remote failed`)
  }
  if (!result.ok) throwRemoteFailure(result)
  return result.value
}

export const agentEnhancerListMcpConnectors = {
  async invoke(remote: unknown, signal?: AbortSignal): Promise<McpConnectorsSnapshot> {
    return callFace(remote, 'listMcpConnectors', {}, signal)
  },
}

export const agentEnhancerUpsertMcpConnector = {
  async invoke(
    remote: unknown,
    request: UpsertMcpConnectorRequest,
    signal?: AbortSignal,
  ): Promise<UpsertMcpConnectorResult> {
    return callFace(remote, 'upsertMcpConnector', request, signal)
  },
}

export const agentEnhancerSetMcpConnectorEnabled = {
  async invoke(
    remote: unknown,
    request: SetMcpConnectorEnabledRequest,
    signal?: AbortSignal,
  ): Promise<SetMcpConnectorEnabledResult> {
    return callFace(remote, 'setMcpConnectorEnabled', request, signal)
  },
}

export const agentEnhancerUninstallMcpConnector = {
  async invoke(
    remote: unknown,
    request: UninstallMcpConnectorRequest,
    signal?: AbortSignal,
  ): Promise<UninstallMcpConnectorResult> {
    return callFace(remote, 'uninstallMcpConnector', request, signal)
  },
}

export const agentEnhancerInstallMcpFromNpx = {
  async invoke(
    remote: unknown,
    request: InstallMcpFromNpxRequest,
    signal?: AbortSignal,
  ): Promise<InstallMcpFromNpxResult> {
    return callFace(remote, 'installMcpFromNpx', request, signal)
  },
}

export const agentEnhancerInstallMcpFromGit = {
  async invoke(
    remote: unknown,
    request: InstallMcpFromGitRequest,
    signal?: AbortSignal,
  ): Promise<InstallMcpFromGitResult> {
    return callFace(remote, 'installMcpFromGit', request, signal)
  },
}

export const agentEnhancerImportMcpJson = {
  async invoke(
    remote: unknown,
    request: ImportMcpJsonRequest,
    signal?: AbortSignal,
  ): Promise<ImportMcpJsonResult> {
    return callFace(remote, 'importMcpJson', request, signal)
  },
}

export const agentEnhancerListMcpConnectorTools = {
  async invoke(
    remote: unknown,
    request: ListMcpConnectorToolsRequest,
    signal?: AbortSignal,
  ): Promise<ListMcpConnectorToolsResult> {
    return callFace(remote, 'listMcpConnectorTools', request, signal)
  },
}

export const agentEnhancerRestartMcpConnector = {
  async invoke(
    remote: unknown,
    request: RestartMcpConnectorRequest,
    signal?: AbortSignal,
  ): Promise<RestartMcpConnectorResult> {
    return callFace(remote, 'restartMcpConnector', request, signal)
  },
}

export const agentEnhancerProbeMcpConnector = {
  async invoke(
    remote: unknown,
    request: ProbeMcpConnectorRequest,
    signal?: AbortSignal,
  ): Promise<ProbeMcpConnectorResult> {
    return callFace(remote, 'probeMcpConnector', request, signal)
  },
}
