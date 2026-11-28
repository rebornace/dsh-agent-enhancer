import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { installRemoteHostBridge } from '../src/host/remote/host-bridge.ts'
import type { BridgeNotice, HostBridgePorts } from '../src/host/remote/host-bridge.ts'
import type { ChannelCapabilities } from '../src/host/remote/types.ts'

const textOnly: ChannelCapabilities = {
  buttons: false,
  editMessage: false,
  threads: false,
  media: 'none',
  markdown: false,
  maxChars: 1800,
  privateOnly: true,
}

type Listener = (...args: unknown[]) => unknown

function harness(options: { readonly shouldHold?: () => boolean } = {}) {
  const handlers = new Map<string, Listener>()
  const ctx = {
    on: (name: string, listener: Listener) => {
      handlers.set(name, listener)
      return () => {
        handlers.delete(name)
      }
    },
  } as unknown as Context
  const notices: BridgeNotice[] = []
  const ports: HostBridgePorts = {
    listSessions: vi.fn(async () => [{ id: 's1', title: '周报导出', running: true }]),
    prompt: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    setPaused: vi.fn(async () => {}),
    notify: (notice: BridgeNotice) => { notices.push(notice) },
  }
  const bridge = installRemoteHostBridge(ctx, {
    ports,
    capabilities: textOnly,
    now: () => 100,
    ...(options.shouldHold === undefined ? {} : { shouldHold: options.shouldHold }),
  })
  return { bridge, handlers, ports, notices }
}

function emit(handlers: Map<string, Listener>, name: string, ...args: unknown[]): unknown {
  const listener = handlers.get(name)
  if (listener === undefined) throw new Error(`missing handler ${name}`)
  return listener(...args)
}

describe('installRemoteHostBridge', () => {
  it('tracks listed sessions and maps turn events', async () => {
    const { bridge, handlers } = harness()
    await bridge.refreshSessions()
    expect(bridge.controller.tasks()).toHaveLength(1)

    emit(handlers, 'session/event', { id: 's1' }, { type: 'turn/start', time: 10, data: { turn: 1 } })
    expect(bridge.controller.tasks()[0]?.state).toBe('running')

    emit(handlers, 'session/event', { id: 's1' }, {
      type: 'turn/end',
      time: 20,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    expect(bridge.controller.tasks()[0]?.state).toBe('done')
  })

  it('maps error turns to failed with the error message', async () => {
    const { bridge, handlers } = harness()
    await bridge.refreshSessions()
    emit(handlers, 'session/event', { id: 's1' }, {
      type: 'turn/end',
      time: 20,
      data: { turn: 1, reason: { kind: 'error', error: { message: '模型超时' } } },
    })
    const task = bridge.controller.tasks()[0]
    expect(task?.state).toBe('failed')
    expect(task?.lastLine).toBe('模型超时')
  })

  it('offers an approval on both surfaces and lets the chat decide', async () => {
    const { bridge, handlers, notices } = harness()
    await bridge.refreshSessions()
    emit(handlers, 'session/event', { id: 's1' }, { type: 'turn/start', time: 10, data: {} })

    const next = vi.fn(() => 'desktop')
    const decision = emit(handlers, 'approval/request', {
      agent: { session: { id: 's1' } },
      toolName: 'write',
      reason: '写入 report.xlsx',
    }, next) as Promise<string>

    // The official desktop card must be shown too, not bypassed.
    expect(next).toHaveBeenCalledOnce()
    const code = bridge.controller.tasks()[0]?.pending?.code
    expect(code).toBeTruthy()
    if (code === undefined) return

    await bridge.controller.execute('chat-1', `批准 ${code}`, textOnly)
    await expect(decision).resolves.toBe('allowed-once')
    expect(notices).toContainEqual({
      kind: 'decided',
      sessionId: 's1',
      decision: 'approve',
      chatId: 'chat-1',
    })
  })

  it('takes the desktop decision and drops the stale remote card', async () => {
    const { bridge, handlers, notices } = harness()
    await bridge.refreshSessions()
    emit(handlers, 'session/event', { id: 's1' }, { type: 'turn/start', time: 10, data: {} })

    let fromDesktop: (value: 'approve') => void = () => {}
    const desktop = new Promise<'approve'>(resolve => { fromDesktop = resolve })
    const decision = emit(handlers, 'approval/request', {
      agent: { session: { id: 's1' } },
      toolName: 'write',
      reason: '写入 report.xlsx',
    }, vi.fn(() => desktop)) as Promise<string>

    const code = bridge.controller.tasks()[0]?.pending?.code
    expect(code).toBeTruthy()
    fromDesktop('approve')
    await expect(decision).resolves.toBe('approve')
    expect(bridge.controller.tasks()[0]?.pending).toBeUndefined()
    expect(notices).toContainEqual({ kind: 'decided', sessionId: 's1', decision: 'approve' })

    if (code === undefined) return
    const late = await bridge.controller.execute('chat-1', `批准 ${code}`, textOnly)
    expect(late.text).not.toContain('已批准')
  })

  it('keeps the remote decision when the desktop card is still open', async () => {
    const { bridge, handlers } = harness()
    await bridge.refreshSessions()
    emit(handlers, 'session/event', { id: 's1' }, { type: 'turn/start', time: 10, data: {} })

    let fromDesktop: (value: 'reject') => void = () => {}
    const desktop = new Promise<'reject'>(resolve => { fromDesktop = resolve })
    const decision = emit(handlers, 'approval/request', {
      agent: { session: { id: 's1' } },
      toolName: 'write',
      reason: '写入 report.xlsx',
    }, vi.fn(() => desktop)) as Promise<string>

    const code = bridge.controller.tasks()[0]?.pending?.code
    if (code === undefined) throw new Error('missing pending')
    await bridge.controller.execute('chat-1', `批准 ${code}`, textOnly)
    await expect(decision).resolves.toBe('allowed-once')
    // Resolving the losing surface later must not throw or change the result.
    fromDesktop('reject')
    await expect(decision).resolves.toBe('allowed-once')
  })

  it('falls through for untracked sessions', async () => {
    const { handlers } = harness()
    const next = vi.fn(() => 'desktop')
    const result = await emit(handlers, 'approval/request', {
      agent: { session: { id: 'unknown' } },
      toolName: 'write',
    }, next)
    expect(next).toHaveBeenCalled()
    expect(result).toBe('desktop')
  })

  it('offers a remote card for a session the host index only lists on refresh', async () => {
    const { bridge, handlers, ports, notices } = harness()
    vi.mocked(ports.listSessions).mockResolvedValueOnce([{ id: 's2', title: '新会话', running: true }])
    const decision = emit(handlers, 'approval/request', {
      agent: { session: { id: 's2' } },
      toolName: 'write',
    }, vi.fn(() => 'desktop')) as Promise<string>

    await vi.waitFor(() => { expect(notices).toHaveLength(1) })
    expect(notices[0]).toMatchObject({ kind: 'approval', sessionId: 's2' })
    const code = bridge.controller.tasks().find(task => task.id === 's2')?.pending?.code
    if (code === undefined) throw new Error('missing pending')
    await bridge.controller.execute('chat-1', `批准 ${code}`, textOnly)
    await expect(decision).resolves.toBe('allowed-once')
  })

  it('maps a single question to the host answer shape', async () => {
    const { bridge, handlers } = harness()
    await bridge.refreshSessions()
    emit(handlers, 'session/event', { id: 's1' }, { type: 'turn/start', time: 10, data: {} })

    const next = vi.fn()
    const answer = emit(handlers, 'user-questions/request', {
      agent: { session: { id: 's1' } },
      questions: [{ id: 'q1', header: '选哪个模板？', options: [{ label: '简洁' }, { label: '详细' }] }],
    }, next) as Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>

    const code = bridge.controller.tasks()[0]?.pending?.code
    if (code === undefined) throw new Error('missing code')
    await bridge.controller.execute('chat-1', `回答 ${code} 详细`, textOnly)
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['详细'] }] })
  })

  it('takes the desktop answer and drops the remote question card', async () => {
    const { bridge, handlers, notices } = harness()
    await bridge.refreshSessions()
    emit(handlers, 'session/event', { id: 's1' }, { type: 'turn/start', time: 10, data: {} })

    const fromDesktop = {
      answers: [{ id: 'q1', selected: ['简洁'] }],
    }
    const answer = emit(handlers, 'user-questions/request', {
      agent: { session: { id: 's1' } },
      questions: [{ id: 'q1', header: '选哪个模板？', options: [{ label: '简洁' }, { label: '详细' }] }],
    }, vi.fn(() => Promise.resolve(fromDesktop))) as Promise<unknown>

    await expect(answer).resolves.toEqual(fromDesktop)
    expect(bridge.controller.tasks()[0]?.pending).toBeUndefined()
    expect(notices).toContainEqual({ kind: 'decided', sessionId: 's1', decision: 'answered' })
  })

  it('refreshes the board when an unseen session emits an event', async () => {
    const { bridge, handlers, ports } = harness()
    await expect(bridge.refreshSessions()).resolves.toBe(1)
    emit(handlers, 'session/event', { id: 'fresh' }, { type: 'turn/start', time: 5_000, data: {} })
    await Promise.resolve()
    await Promise.resolve()
    expect(ports.listSessions).toHaveBeenCalledTimes(2)
  })

  it('notices an approval and a question once each', async () => {
    const { bridge, handlers, notices } = harness()
    await bridge.refreshSessions()
    emit(handlers, 'session/event', { id: 's1' }, { type: 'turn/start', time: 10, data: {} })

    const approval = emit(handlers, 'approval/request', {
      agent: { session: { id: 's1' } },
      toolName: 'write',
      reason: '写入 report.xlsx',
    }, () => undefined) as Promise<string>
    expect(notices).toEqual([{ kind: 'approval', sessionId: 's1', code: expect.any(String) }])
    bridge.controller.releasePending()
    await approval

    const question = emit(handlers, 'user-questions/request', {
      agent: { session: { id: 's1' } },
      questions: [{ id: 'q1', header: '用哪个模板？' }],
    }, () => undefined) as Promise<unknown>
    expect(notices[1]).toMatchObject({ kind: 'question', sessionId: 's1' })
    bridge.controller.releasePending()
    await question
  })

  it('pushes the answer on every completed turn, not only remote ones', async () => {
    const { bridge, handlers, notices } = harness()
    await bridge.refreshSessions()

    emit(handlers, 'session/event', { id: 's1' }, {
      type: 'turn/end',
      time: 20,
      data: { reason: { kind: 'error', error: { message: '模型超时' } } },
    })
    expect(notices[0]).toMatchObject({ kind: 'failed', sessionId: 's1', error: '模型超时' })

    // A turn started at the desktop still belongs to a tracked task; the user
    // may be away, so its answer is pushed as well.
    emit(handlers, 'session/event', { id: 's1' }, { type: 'turn/start', time: 30, data: {} })
    emit(handlers, 'session/event', { id: 's1' }, {
      type: 'assistant/message',
      time: 31,
      data: { message: { content: [{ type: 'text', text: '桌面上的回答' }] } },
    })
    emit(handlers, 'session/event', { id: 's1' }, { type: 'turn/end', time: 32, data: { reason: { kind: 'completed' } } })
    expect(notices[1]).toEqual({ kind: 'done', sessionId: 's1', answer: '桌面上的回答' })

    // A prompt sent from the remote chat behaves the same way.
    await bridge.controller.execute('chat-1', '整理成三条', textOnly)
    emit(handlers, 'session/event', { id: 's1' }, { type: 'turn/start', time: 40, data: {} })
    emit(handlers, 'session/event', { id: 's1' }, {
      type: 'assistant/message',
      time: 41,
      data: { message: { content: [{ type: 'text', text: '第一条…\n第二条…' }] } },
    })
    emit(handlers, 'session/event', { id: 's1' }, { type: 'turn/end', time: 42, data: { reason: { kind: 'completed' } } })
    expect(notices[2]).toEqual({ kind: 'done', sessionId: 's1', answer: '第一条…\n第二条…' })
  })

  it('passes an approval through while no chat can answer', async () => {
    const { bridge, handlers } = harness({ shouldHold: () => false })
    await bridge.refreshSessions()
    emit(handlers, 'session/event', { id: 's1' }, { type: 'turn/start', time: 10, data: {} })

    const next = vi.fn(() => 'desktop')
    const result = await emit(handlers, 'approval/request', {
      agent: { session: { id: 's1' } },
      toolName: 'write',
    }, next)

    expect(next).toHaveBeenCalledOnce()
    expect(result).toBe('desktop')
    expect(bridge.controller.tasks()[0]?.pending).toBeUndefined()
  })

  it('leaves multi-question cards to the desktop', async () => {
    const { handlers } = harness()
    const next = vi.fn(() => 'desktop')
    const result = await emit(handlers, 'user-questions/request', {
      agent: { session: { id: 's1' } },
      questions: [{ id: 'q1' }, { id: 'q2' }],
    }, next)
    expect(next).toHaveBeenCalled()
    expect(result).toBe('desktop')
  })

  it('unsubscribes on dispose', () => {
    const { bridge, handlers } = harness()
    expect(handlers.size).toBe(3)
    bridge.dispose()
    expect(handlers.size).toBe(0)
  })
})
