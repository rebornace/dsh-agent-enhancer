import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createHostPorts } from '../src/host/remote/ports.ts'

function ctxWith(proxy: unknown): Context {
  return {
    get: (name: string) => (name === 'apiProxy' ? proxy : undefined),
  } as unknown as Context
}

function ok(value: unknown) {
  return { result: { ok: true, value } }
}

function fail(message: string) {
  return { result: { ok: false, error: { code: 'bad', message } } }
}

describe('createHostPorts', () => {
  it('lists sessions with projection titles and a safe fallback', async () => {
    const list = vi.fn(async () => ok({
      items: [
        { sessionId: 's1', running: true, projections: { values: { title: '周报导出' } } },
        { sessionId: 's2', running: false },
        { nope: true },
      ],
    }))
    const ctx = ctxWith({ sessions: { list, prompt: vi.fn(), cancel: vi.fn() } })
    const ports = createHostPorts(ctx, { setPaused: vi.fn() })

    await expect(ports.listSessions()).resolves.toEqual([
      { id: 's1', title: '周报导出', running: true },
      { id: 's2', title: 's2', running: false },
    ])
    expect(list).toHaveBeenCalledWith(
      { rpcId: 'agent-enhancer-remote', method: 'session.list', payload: {} },
      expect.any(AbortSignal),
    )
  })

  it('sends a prompt as a text part with the requested delivery mode', async () => {
    const prompt = vi.fn(async (_envelope: unknown) => ok({ accepted: true }))
    const ctx = ctxWith({ sessions: { list: vi.fn(), prompt, cancel: vi.fn() } })
    const ports = createHostPorts(ctx, { setPaused: vi.fn() })

    await ports.prompt('s1', '帮我改一下', 'queue')
    const envelope = prompt.mock.calls[0]?.[0] as {
      payload?: { sessionId?: string; mode?: string; content?: unknown; requestId?: string }
    } | undefined
    expect(envelope).toMatchObject({
      rpcId: 'agent-enhancer-remote',
      method: 'session.prompt',
      payload: {
        sessionId: 's1',
        mode: 'queue',
        content: [{ type: 'text', text: '帮我改一下' }],
      },
    })
    expect(typeof envelope?.payload?.requestId).toBe('string')
  })

  it('surfaces host errors instead of swallowing them', async () => {
    const ctx = ctxWith({
      sessions: { list: vi.fn(), prompt: vi.fn(async () => fail('会话已归档')), cancel: vi.fn() },
    })
    const ports = createHostPorts(ctx, { setPaused: vi.fn() })
    await expect(ports.prompt('s1', 'hi', 'queue')).rejects.toThrow('会话已归档')
  })

  it('cancels by session id and delegates soft pause', async () => {
    const cancel = vi.fn(async () => ok({ accepted: true }))
    const setPaused = vi.fn(async () => {})
    const ctx = ctxWith({ sessions: { list: vi.fn(), prompt: vi.fn(), cancel } })
    const ports = createHostPorts(ctx, { setPaused })

    await ports.cancel('s1')
    expect(cancel).toHaveBeenCalledWith(
      { rpcId: 'agent-enhancer-remote', method: 'session.cancel', payload: { sessionId: 's1' } },
      expect.any(AbortSignal),
    )

    await ports.setPaused('s1', true)
    expect(setPaused).toHaveBeenCalledWith('s1', true)
  })

  it('fails loudly when the host has no apiProxy', async () => {
    const ports = createHostPorts(ctxWith(undefined), { setPaused: vi.fn() })
    await expect(ports.listSessions()).rejects.toThrow(/apiProxy/)
  })
})
