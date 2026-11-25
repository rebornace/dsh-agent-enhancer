import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { installRemoteHostBridge } from '../src/host/remote/host-bridge.ts'
import type { HostBridgePorts } from '../src/host/remote/host-bridge.ts'
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

function harness() {
  const handlers = new Map<string, Listener>()
  const ctx = {
    on: (name: string, listener: Listener) => {
      handlers.set(name, listener)
      return () => {
        handlers.delete(name)
      }
    },
  } as unknown as Context
  const ports: HostBridgePorts = {
    listSessions: vi.fn(async () => [{ id: 's1', title: '周报导出', running: true }]),
    prompt: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    setPaused: vi.fn(async () => {}),
  }
  const bridge = installRemoteHostBridge(ctx, { ports, capabilities: textOnly, now: () => 100 })
  return { bridge, handlers, ports }
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

  it('holds an approval request until the chat answers it', async () => {
    const { bridge, handlers } = harness()
    await bridge.refreshSessions()
    emit(handlers, 'session/event', { id: 's1' }, { type: 'turn/start', time: 10, data: {} })

    const next = vi.fn(() => 'desktop')
    const decision = emit(handlers, 'approval/request', {
      agent: { session: { id: 's1' } },
      toolName: 'write',
      reason: '写入 report.xlsx',
    }, next) as Promise<'approve' | 'reject'>

    expect(next).not.toHaveBeenCalled()
    const code = bridge.controller.tasks()[0]?.pending?.code
    expect(code).toBeTruthy()
    if (code === undefined) return

    await bridge.controller.execute('chat-1', `批准 ${code}`, textOnly)
    await expect(decision).resolves.toBe('approve')
  })

  it('falls through for untracked sessions', () => {
    const { handlers } = harness()
    const next = vi.fn(() => 'desktop')
    const result = emit(handlers, 'approval/request', {
      agent: { session: { id: 'unknown' } },
      toolName: 'write',
    }, next)
    expect(next).toHaveBeenCalled()
    expect(result).toBe('desktop')
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

  it('leaves multi-question cards to the desktop', () => {
    const { handlers } = harness()
    const next = vi.fn(() => 'desktop')
    const result = emit(handlers, 'user-questions/request', {
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
