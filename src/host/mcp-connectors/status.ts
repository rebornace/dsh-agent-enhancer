import type { McpConnectorRuntimeStatus, McpConnectorStatusState } from './types.ts'

/** Subset of official mcp-client connection status used for UI summary. */
export type McpConnectionStatusLike =
  | { readonly state: 'closed'; readonly result?: { readonly cleanupError?: string } }
  | { readonly state: 'waiting-credentials'; readonly lastError: string }
  | { readonly state: 'connecting'; readonly attempt: number }
  | { readonly state: 'connected'; readonly toolCount: number; readonly connectedAt?: number }
  | {
    readonly state: 'reconnecting'
    readonly attempt: number
    readonly maxAttempts: number
    readonly lastError: string
  }
  | {
    readonly state: 'failed'
    readonly reason: string
    readonly lastError?: string
  }

/** Map official mcp-client connection status into a stable UI wire shape. */
export function summarizeMcpConnectionStatus(
  status: McpConnectionStatusLike | null | undefined,
): McpConnectorRuntimeStatus {
  if (status === null || status === undefined) {
    return { state: 'unmounted', detail: null, toolCount: null }
  }
  switch (status.state) {
    case 'connected':
      return {
        state: 'connected',
        detail: null,
        toolCount: status.toolCount,
      }
    case 'connecting':
      return {
        state: 'connecting',
        detail: status.attempt > 0 ? `attempt ${status.attempt + 1}` : null,
        toolCount: null,
      }
    case 'reconnecting':
      return {
        state: 'reconnecting',
        detail: status.lastError.trim() !== ''
          ? status.lastError
          : `attempt ${status.attempt}/${status.maxAttempts}`,
        toolCount: null,
      }
    case 'waiting-credentials':
      return {
        state: 'waiting-credentials',
        detail: status.lastError.trim() !== '' ? status.lastError : null,
        toolCount: null,
      }
    case 'failed':
      return {
        state: 'failed',
        detail: status.lastError?.trim()
          ? `${status.reason}: ${status.lastError}`
          : status.reason,
        toolCount: null,
      }
    case 'closed':
      return {
        state: 'closed',
        detail: status.result?.cleanupError ?? null,
        toolCount: null,
      }
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}

export function disabledMcpStatus(): McpConnectorRuntimeStatus {
  return { state: 'disabled', detail: null, toolCount: null }
}

export function isLiveMcpStatusState(state: McpConnectorStatusState): boolean {
  return state === 'connected'
    || state === 'connecting'
    || state === 'reconnecting'
    || state === 'waiting-credentials'
}
