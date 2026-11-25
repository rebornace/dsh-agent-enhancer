import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { SessionRow } from './controller.ts'
import type { HostBridgePorts } from './host-bridge.ts'

interface ProxyFailure {
  readonly code?: string
  readonly message?: string
}

interface ProxyResponse {
  readonly result?: {
    readonly ok?: boolean
    readonly value?: unknown
    readonly error?: ProxyFailure
  }
}

interface SessionsProxy {
  list(request: unknown, signal?: AbortSignal): Promise<ProxyResponse>
  prompt(request: unknown, signal?: AbortSignal): Promise<ProxyResponse>
  cancel(request: unknown, signal?: AbortSignal): Promise<ProxyResponse>
}

interface ApiProxyLike {
  readonly sessions: SessionsProxy
}

export interface CreateHostPortsOptions {
  /** Soft pause owned by this plugin; there is no host RPC for it. */
  readonly setPaused: (sessionId: string, paused: boolean) => Promise<void>
}

const RPC_ID = 'agent-enhancer-remote'

function request(method: string, payload: unknown): unknown {
  return { rpcId: RPC_ID, method: `session.${method}`, payload }
}

function unwrap(response: ProxyResponse): unknown {
  const result = response?.result
  if (result?.ok !== true) {
    const message = typeof result?.error?.message === 'string' && result.error.message !== ''
      ? result.error.message
      : '宿主请求失败'
    throw new Error(message)
  }
  return result.value
}

function titleOf(item: Record<string, unknown>, sessionId: string): string {
  const projections = item.projections
  if (projections !== null && typeof projections === 'object') {
    const values = (projections as { values?: unknown }).values
    if (values !== null && typeof values === 'object') {
      const title = (values as { title?: unknown }).title
      if (typeof title === 'string' && title.trim() !== '') return title
    }
  }
  return sessionId.slice(0, 8)
}

function toRow(item: unknown): SessionRow | undefined {
  if (item === null || typeof item !== 'object') return undefined
  const record = item as Record<string, unknown>
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined
  if (sessionId === undefined || sessionId === '') return undefined
  return {
    id: sessionId,
    title: titleOf(record, sessionId),
    running: record.running === true,
  }
}

/**
 * `apiProxy` is the host's local bridge for the Session Controller methods the
 * mobile/remote surfaces use (`{ rpcId, method, payload }` → `{ result }`).
 * Reusing it keeps this plugin off a second copy of the identity plumbing.
 */
function apiProxy(ctx: Context): ApiProxyLike {
  const proxy = ctx.get('apiProxy') as ApiProxyLike | undefined
  if (proxy === undefined || proxy.sessions === undefined) {
    throw new Error('宿主没有提供 apiProxy，远程控制无法工作')
  }
  return proxy
}

export function createHostPorts(ctx: Context, options: CreateHostPortsOptions): HostBridgePorts {
  return {
    async listSessions() {
      const signal = new AbortController().signal
      const value = unwrap(await apiProxy(ctx).sessions.list(request('list', {}), signal))
      const items = value !== null && typeof value === 'object'
        ? (value as { items?: unknown }).items
        : undefined
      if (!Array.isArray(items)) return []
      const rows: SessionRow[] = []
      for (const item of items) {
        const row = toRow(item)
        if (row !== undefined) rows.push(row)
      }
      return rows
    },

    async prompt(sessionId, text, mode) {
      const payload = {
        requestId: randomUUID(),
        sessionId,
        mode,
        content: [{ type: 'text', text }],
      }
      const signal = new AbortController().signal
      unwrap(await apiProxy(ctx).sessions.prompt(request('prompt', payload), signal))
    },

    async cancel(sessionId) {
      const signal = new AbortController().signal
      unwrap(await apiProxy(ctx).sessions.cancel(request('cancel', { sessionId }), signal))
    },

    async setPaused(sessionId, paused) {
      await options.setPaused(sessionId, paused)
    },
  }
}
