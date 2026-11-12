import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CreateWebChatWorkspaceResult,
  ImportWebChatHistoryRequest,
  ImportWebChatHistoryNowResult,
  WebChatWorkspaceRow,
} from '../../host/web-chat-bridge/import-session.ts'
import type { WebChatImportErrorCode } from '../../host/web-chat-bridge/import-session.ts'
import type { WebChatTranscript } from '../../host/web-chat-bridge/types.ts'

export type WebChatBridgeRemoteSource = () => { readonly agentEnhancer: object } | undefined

export class WebChatBridgeRemoteError extends Error {
  constructor(
    readonly webChatCode: WebChatImportErrorCode,
    message: string,
    readonly sessionId?: SessionId,
  ) {
    super(message)
    this.name = 'WebChatBridgeRemoteError'
  }
}

function agentFace(remote: WebChatBridgeRemoteSource): object {
  const source = remote()
  if (source === undefined) {
    throw new WebChatBridgeRemoteError('import-failed', 'agentEnhancer remote is unavailable')
  }
  const namespace = source.agentEnhancer
  if (typeof namespace !== 'object') {
    throw new WebChatBridgeRemoteError('import-failed', 'agentEnhancer remote is unavailable')
  }
  return namespace
}

function webChatCodeOf(details: unknown): WebChatImportErrorCode | undefined {
  if (details === null || typeof details !== 'object') return undefined
  const raw = Reflect.get(details, 'webChatCode')
  if (
    raw === 'no-workspace'
    || raw === 'missing-cwd'
    || raw === 'invalid-transcript'
    || raw === 'import-failed'
  ) {
    return raw
  }
  return undefined
}

function sessionIdOf(details: unknown): SessionId | undefined {
  if (details === null || typeof details !== 'object') return undefined
  const raw = Reflect.get(details, 'sessionId')
  return typeof raw === 'string' && raw.trim() !== '' ? raw as SessionId : undefined
}

function parseWebChatCodePrefix(message: string): WebChatImportErrorCode | undefined {
  const match = message.match(/^(no-workspace|missing-cwd|invalid-transcript|import-failed):/)
  return match?.[1] as WebChatImportErrorCode | undefined
}

function throwRemoteFailure(result: Extract<RemoteResult<unknown>, { readonly ok: false }>): never {
  const message = result.error.message
  const fromDetails = webChatCodeOf(result.error.details)
  const fromPrefix = parseWebChatCodePrefix(message)
  const code = fromDetails ?? fromPrefix ?? 'import-failed'
  const sessionId = sessionIdOf(result.error.details)
  const stripped = message.replace(
    /^(no-workspace|missing-cwd|invalid-transcript|import-failed):\s*/i,
    '',
  )
  throw new WebChatBridgeRemoteError(code, stripped || message, sessionId)
}

async function callFace<T>(
  remote: WebChatBridgeRemoteSource,
  method: string,
  request: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const namespace = agentFace(remote)
  const call = Reflect.get(namespace, method) as
    | ((req: unknown, sig?: AbortSignal) => Promise<RemoteResult<T>>)
    | undefined
  if (typeof call !== 'function') {
    throw new WebChatBridgeRemoteError('import-failed', `${method} remote is unavailable`)
  }
  let result: RemoteResult<T>
  try {
    result = await call.apply(namespace, [request, signal])
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
    throw new WebChatBridgeRemoteError(
      'import-failed',
      error instanceof Error ? error.message : String(error),
    )
  }
  if (!result.ok) throwRemoteFailure(result)
  return result.value
}

export const agentEnhancerListWebChatWorkspaces = {
  async invoke(
    remote: WebChatBridgeRemoteSource,
    signal?: AbortSignal,
  ): Promise<{ readonly items: readonly WebChatWorkspaceRow[] }> {
    return callFace(remote, 'listWebChatWorkspaces', {}, signal)
  },
}

export const agentEnhancerCreateWebChatWorkspace = {
  async invoke(
    remote: WebChatBridgeRemoteSource,
    signal?: AbortSignal,
  ): Promise<CreateWebChatWorkspaceResult> {
    return callFace(remote, 'createWebChatWorkspace', {}, signal)
  },
}

export const agentEnhancerImportWebChatHistory = {
  async invoke(
    remote: WebChatBridgeRemoteSource,
    request: ImportWebChatHistoryRequest,
    signal?: AbortSignal,
  ): Promise<ImportWebChatHistoryNowResult> {
    return callFace(remote, 'importWebChatHistory', request, signal)
  },
}

export const agentEnhancerResolveWebChatShareLink = {
  async invoke(
    remote: WebChatBridgeRemoteSource,
    request: { readonly shareUrl: string, readonly payloadJson?: string },
    signal?: AbortSignal,
  ): Promise<{ readonly transcript: WebChatTranscript }> {
    return callFace(remote, 'resolveWebChatShareLink', request, signal)
  },
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const slice = bytes.subarray(offset, offset + chunk)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}
