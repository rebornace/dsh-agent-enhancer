import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SESSION_FORMAT_VERSION, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshCheckpointSessions } from '../src/host/checkpoint/dsh.ts'

const contexts: Context[] = []
const sessionId = 'session-real' as SessionId
const workspaceRoot = 'C:/workspace/project'

function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  const session = Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    isSeeded: false,
    cwd: workspaceRoot,
  }, SessionLogOffset(0))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', {
    id: MessageId('user-1'), role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'real event snapshot' }],
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const runMaintenance = vi.fn(async <T,>(task: (signal: AbortSignal) => Promise<T>) =>
    task(new AbortController().signal))
  const agent = { id: sessionId, session, status: 'idle' as const, runMaintenance }
  const flush = vi.fn(async () => true)
  const snapshot = vi.fn(() => ({ asOfSeq: 2, values: {} }))
  ctx.provide('sessions', { get: vi.fn(() => session), flush } as never)
  ctx.provide('agents', { get: vi.fn(() => agent) } as never)
  ctx.provide('sessionProjections', { snapshot } as never)
  return { ctx, session, agent, runMaintenance, flush, snapshot }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('DshCheckpointSessions', () => {
  it('adapts the exact live Agent Session with its complete event snapshot and workspace root', () => {
    const h = fixture()
    const sessions = new DshCheckpointSessions(h.ctx)
    const adapter = sessions.resolveSession(sessionId)

    expect(adapter).toBeDefined()
    expect(adapter!.session).toBe(h.session)
    expect(adapter!.workspaceRoot).toBe(workspaceRoot)
    expect(adapter!.status).toBe('idle')
    expect(adapter!.canRestore).toBe(true)
    expect(adapter!.readEvents()).toEqual(h.session.snapshotEvents())
    expect(adapter!.readEvents().slice(-3).map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'turn/end',
    ])
    expect(sessions.resolveSession(sessionId)).toBe(adapter)
  })

  it('uses the public Agent maintenance lock and synchronizes projections before flushing Session durability', async () => {
    const h = fixture()
    const adapter = new DshCheckpointSessions(h.ctx).resolveSession(sessionId)!
    const signal = new AbortController().signal

    await expect(adapter.runMaintenance(async maintenanceSignal => {
      expect(maintenanceSignal).toBeInstanceOf(AbortSignal)
      return 'maintenance-result'
    })).resolves.toBe('maintenance-result')
    expect(h.runMaintenance).toHaveBeenCalledTimes(1)

    await adapter.synchronize(signal)
    expect(h.snapshot).toHaveBeenCalledWith(h.session)
    expect(h.flush).toHaveBeenCalledWith(h.session)
    expect(h.snapshot.mock.invocationCallOrder[0]).toBeLessThan(h.flush.mock.invocationCallOrder[0]!)
  })
})
