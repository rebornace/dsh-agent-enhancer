import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SESSION_FORMAT_VERSION, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshCheckpointSessions } from '../src/host/checkpoint/dsh.ts'

const contexts: Context[] = []
const sessionId = 'session-real' as SessionId
// `Session.create` requires an absolute cwd, and "C:/…" is not absolute on Linux CI.
const workspaceRoot = resolve('/workspace/project')

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
  const setPhase = vi.fn()
  const agent = {
    id: sessionId,
    session,
    status: 'idle' as const,
    runMaintenance,
    phase: { kind: 'idle' as const, lastTurn: 1 },
    setPhase,
  }
  const flush = vi.fn(async () => true)
  const snapshot = vi.fn(() => ({ asOfSeq: 2, values: {} }))
  const turnBoundaryOf = vi.fn(() => ({ lastTurn: 1 }))
  ctx.provide('sessions', { get: vi.fn(() => session), flush } as never)
  ctx.provide('agents', { get: vi.fn(() => agent), turnBoundaryOf } as never)
  ctx.provide('sessionProjections', { snapshot } as never)
  return { ctx, session, agent, runMaintenance, setPhase, turnBoundaryOf, flush, snapshot }
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
    expect(h.snapshot).toHaveBeenCalledTimes(2)
    expect(h.snapshot.mock.invocationCallOrder[0]).toBeLessThan(h.flush.mock.invocationCallOrder[0]!)
    expect(h.flush.mock.invocationCallOrder[0]).toBeLessThan(h.snapshot.mock.invocationCallOrder[1]!)

    h.flush.mockResolvedValueOnce(false)
    await expect(adapter.synchronize(signal)).resolves.toBeUndefined()
    expect(h.snapshot).toHaveBeenCalledTimes(4)
  })

  it('refreshes Agent lastTurn from agents.turnBoundaryOf after maintenance so undo shells do not collide', async () => {
    const h = fixture()
    h.turnBoundaryOf.mockReturnValue({ lastTurn: 2 })
    const adapter = new DshCheckpointSessions(h.ctx).resolveSession(sessionId)!

    await adapter.runMaintenance(async () => 'ok')
    expect(h.turnBoundaryOf).toHaveBeenCalledWith(h.session)
    expect(h.setPhase).toHaveBeenCalledWith({ kind: 'idle', lastTurn: 2 })
  })

  it('keeps resolving when SessionStore rebinds a new object for the same Session id', () => {
    const h = fixture()
    const sessions = new DshCheckpointSessions(h.ctx)
    const first = sessions.resolveSession(sessionId)
    expect(first).toBeDefined()

    const rebound = Object.create(h.session) as typeof h.session
    Object.defineProperty(rebound, 'id', { value: h.session.id })
    ;(h.ctx.get('sessions') as unknown as { get: ReturnType<typeof vi.fn> }).get.mockReturnValue(rebound)

    const second = sessions.resolveSession(sessionId)
    expect(second).toBe(first)
    expect(second!.session).toBe(h.session)
  })

  it('drops the adapter when the registered Session id no longer matches the Agent', () => {
    const h = fixture()
    const sessions = new DshCheckpointSessions(h.ctx)
    expect(sessions.resolveSession(sessionId)).toBeDefined()
    ;(h.ctx.get('sessions') as unknown as { get: ReturnType<typeof vi.fn> }).get.mockReturnValue({
      id: 'session-other' as SessionId,
    })
    expect(sessions.resolveSession(sessionId)).toBeUndefined()
  })
})
