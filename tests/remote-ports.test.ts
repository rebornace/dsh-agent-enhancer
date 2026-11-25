import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createHostPorts } from '../src/host/remote/ports.ts'

function ctxWith(controller: unknown): Context {
  return {
    get: (name: string) => (name === 'sessionController' ? controller : undefined),
  } as unknown as Context
}

describe('createHostPorts', () => {
  it('lists sessions with projection titles and a safe fallback', async () => {
    const list = vi.fn(async () => ({
      items: [
        { sessionId: 's1', running: true, projections: { values: { title: '周报导出' } } },
        { sessionId: 's2', running: false },
        { sessionId: 's3', running: true, origin: 'subagent' },
        { nope: true },
      ],
    }))
    const ctx = ctxWith({ list, prompt: vi.fn(), cancel: vi.fn() })
    const ports = createHostPorts(ctx, { setPaused: vi.fn() })

    await expect(ports.listSessions()).resolves.toEqual([
      { id: 's1', title: '周报导出', running: true },
      { id: 's2', title: 's2', running: false },
    ])
    expect(list).toHaveBeenCalledWith({}, expect.any(AbortSignal))
  })

  it('sends a prompt as a text part with the requested delivery mode', async () => {
    const prompt = vi.fn(async (_request: unknown) => ({ accepted: true }))
    const ctx = ctxWith({ list: vi.fn(), prompt, cancel: vi.fn() })
    const ports = createHostPorts(ctx, { setPaused: vi.fn() })

    await ports.prompt('s1', '帮我改一下', 'queue')
    const request = prompt.mock.calls[0]?.[0] as {
      sessionId?: string
      mode?: string
      content?: unknown
      requestId?: string
    } | undefined
    expect(request).toMatchObject({
      sessionId: 's1',
      mode: 'queue',
      content: [{ type: 'text', text: '帮我改一下' }],
    })
    expect(typeof request?.requestId).toBe('string')
  })

  it('surfaces host errors instead of swallowing them', async () => {
    const ctx = ctxWith({
      list: vi.fn(),
      prompt: vi.fn(async () => {
        throw new Error('会话已归档')
      }),
      cancel: vi.fn(),
    })
    const ports = createHostPorts(ctx, { setPaused: vi.fn() })
    await expect(ports.prompt('s1', 'hi', 'queue')).rejects.toThrow('会话已归档')
  })

  it('cancels by session id and delegates soft pause', async () => {
    const cancel = vi.fn(async () => ({ accepted: true }))
    const setPaused = vi.fn(async () => {})
    const ctx = ctxWith({ list: vi.fn(), prompt: vi.fn(), cancel })
    const ports = createHostPorts(ctx, { setPaused })

    await ports.cancel('s1')
    expect(cancel).toHaveBeenCalledWith({ sessionId: 's1' })

    await ports.setPaused('s1', true)
    expect(setPaused).toHaveBeenCalledWith('s1', true)
  })

  it('fails loudly when the host has no session controller', async () => {
    const ports = createHostPorts(ctxWith(undefined), { setPaused: vi.fn() })
    await expect(ports.listSessions()).rejects.toThrow(/sessionController/)
  })
})
