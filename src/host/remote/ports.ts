import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRow } from './controller.ts'
import type { HostBridgePorts } from './host-bridge.ts'

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
  // A subagent is an implementation detail of its parent's task, not a task.
  if (record.origin === 'subagent') return undefined
  return {
    id: sessionId,
    title: titleOf(record, sessionId),
    running: record.running === true,
  }
}

/**
 * The host owns sessions through `ctx.sessionController` — the same service the
 * desktop UI talks to. `ctx.get` is a soft lookup: this plugin must not add the
 * controller to `inject`, or a host without it would fail to load at all.
 */
function controllerOf(ctx: Context): SessionController {
  let service: unknown
  try {
    service = ctx.get('sessionController')
  } catch {
    service = undefined
  }
  if (service === null || service === undefined || typeof service !== 'object'
    || typeof (service as { list?: unknown }).list !== 'function') {
    throw new Error('宿主没有提供 sessionController，远程控制无法工作')
  }
  return service as SessionController
}

type PromptRequest = Parameters<SessionController['prompt']>[0]
type CancelRequest = Parameters<SessionController['cancel']>[0]

export function createHostPorts(
  ctx: Context,
  options: { readonly setPaused: (sessionId: string, paused: boolean) => Promise<void> },
): HostBridgePorts {
  return {
    async listSessions() {
      const signal = new AbortController().signal
      const value = await controllerOf(ctx).list({}, signal)
      const items = value !== null && typeof value === 'object' ? value.items : undefined
      if (!Array.isArray(items)) return []
      const rows: SessionRow[] = []
      for (const item of items) {
        const row = toRow(item)
        if (row !== undefined) rows.push(row)
      }
      return rows
    },

    async prompt(sessionId, text, mode) {
      const request: PromptRequest = {
        requestId: randomUUID() as PromptRequest['requestId'],
        sessionId: sessionId as PromptRequest['sessionId'],
        mode,
        content: [{ type: 'text', text }],
      }
      await controllerOf(ctx).prompt(request, new AbortController().signal)
    },

    async cancel(sessionId) {
      const request = { sessionId: sessionId as CancelRequest['sessionId'] }
      await controllerOf(ctx).cancel(request)
    },

    async setPaused(sessionId, paused) {
      await options.setPaused(sessionId, paused)
    },
  }
}
