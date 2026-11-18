import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId as brandSessionId } from '@deepseek-ai/dsh-session'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  appendTranscript,
  assertResolvableWorkspaceCwd,
  buildWebChatImportSeed,
  importWebChatHistoryNow,
  importWebChatHistoryWithContext,
  listWebChatWorkspacesNow,
  resolveWebChatImportTitle,
  webChatImportToRemoteError,
  WebChatImportError,
} from '../src/host/web-chat-bridge/import-session.ts'
import { WEB_CHAT_MAX_MESSAGES, WEB_CHAT_MAX_TEXT_BYTES } from '../src/host/web-chat-bridge/limits.ts'

let workspaceCwd = ''
beforeAll(() => {
  workspaceCwd = mkdtempSync(join(tmpdir(), 'dsh-webchat-ws-'))
})
afterAll(() => {
  try { rmSync(workspaceCwd, { recursive: true, force: true }) } catch { /* ignore */ }
})

function baseTranscript(turns: Array<{ role: 'user' | 'assistant', text: string }>) {
  return {
    title: 'DeepSeek',
    partial: false,
    turns,
    source: { kind: 'official-export' as const, capturedAt: '2026-11-09T00:00:00.000Z' },
  }
}

/** Flatten Session.append overloads (single event + batch tuples) for assertions. */
function flattenAppendCalls(append: ReturnType<typeof vi.fn>): Array<[string, unknown, unknown?]> {
  const out: Array<[string, unknown, unknown?]> = []
  for (const call of append.mock.calls) {
    const head = call[0]
    if (typeof head === 'string') {
      out.push([head, call[1], call[2]])
      continue
    }
    if (Array.isArray(head)) {
      for (const input of head) {
        out.push([input[0], input[1], input[2]])
      }
    }
  }
  return out
}

function mockSeedImport() {
  const dispose = vi.fn(async () => undefined)
  const flush = vi.fn(async () => true)
  const sessionCreate = vi.fn()
  const create = vi.fn(async (options: {
    sessionId: string
    seed: readonly { type: string, data?: { reason?: { kind?: string } } }[]
    meta: { cwd: string }
    agentOptions?: { provider?: string }
  }) => ({
    agent: {
      id: options.sessionId,
      session: { id: options.sessionId, append: vi.fn() },
    },
    dispose,
  }))
  return { dispose, flush, sessionCreate, create }
}

describe('appendTranscript consecutive roles', () => {
  it('seeds an inert system/message as the protected first surface head', () => {
    const append = vi.fn()
    appendTranscript({ append } as never, baseTranscript([
      { role: 'user', text: 'only' },
    ]))
    const calls = flattenAppendCalls(append)
    const types = calls.map(call => call[0])
    expect(types[0]).toBe('turn/start')
    expect(types[1]).toBe('step/start')
    expect(types[2]).toBe('system/message')
    expect(calls[2]?.[2]).toMatchObject({ surfaceOp: 'append' })
    expect(calls[2]?.[1]).toMatchObject({
      turn: 1,
      step: 1,
      message: { role: 'system', content: [], source: { kind: 'system-prompt' } },
    })
    const firstSurface = types.findIndex(type =>
      type === 'system/message'
      || type === 'user/message'
      || type === 'assistant/message'
    )
    expect(types[firstSurface]).toBe('system/message')
  })

  it('closes and opens turns for two consecutive user messages', () => {
    const append = vi.fn()
    const session = { append } as never
    appendTranscript(session, baseTranscript([
      { role: 'user', text: 'u1' },
      { role: 'user', text: 'u2' },
    ]))
    const types = flattenAppendCalls(append).map(call => call[0])
    expect(types.filter(t => t === 'turn/start')).toHaveLength(2)
    expect(types.filter(t => t === 'turn/end')).toHaveLength(2)
    expect(types.filter(t => t === 'user/message')).toHaveLength(2)
    expect(types.filter(t => t === 'system/message')).toHaveLength(1)
    expect(types.at(-1)).toBe('session/title')
    expect(types.filter(t => t === 'turn/end').length).toBe(2)
    const endIdx = types.indexOf('turn/end')
    const secondStart = types.indexOf('turn/start', types.indexOf('turn/start') + 1)
    expect(endIdx).toBeLessThan(secondStart)
  })

  it('uses two steps in one turn for two consecutive assistant messages', () => {
    const append = vi.fn()
    const session = { append } as never
    appendTranscript(session, baseTranscript([
      { role: 'user', text: 'u' },
      { role: 'assistant', text: 'a1' },
      { role: 'assistant', text: 'a2' },
    ]))
    const calls = flattenAppendCalls(append)
    const types = calls.map(call => call[0])
    expect(types.filter(t => t === 'turn/start')).toHaveLength(1)
    // step 1 = protected system head; assistant replies use step 2 and 3
    expect(types.filter(t => t === 'step/start')).toHaveLength(3)
    expect(types.filter(t => t === 'assistant/message')).toHaveLength(2)
    expect(types.filter(t => t === 'turn/end')).toHaveLength(1)
    const steps = calls
      .filter(call => call[0] === 'step/start')
      .map(call => (call[1] as { step: number }).step)
    expect(steps).toEqual([1, 2, 3])
    expect(types.at(-1)).toBe('session/title')
  })

  it('closes a transcript that ends on a user turn', () => {
    const append = vi.fn()
    appendTranscript({ append } as never, baseTranscript([
      { role: 'user', text: 'only' },
    ]))
    const calls = flattenAppendCalls(append)
    const types = calls.map(call => call[0])
    expect(types.filter(t => t === 'turn/start')).toHaveLength(1)
    expect(types.filter(t => t === 'turn/end')).toHaveLength(1)
    expect(types.at(-1)).toBe('session/title')
    const turnEnd = calls.find(call => call[0] === 'turn/end')
    expect(turnEnd?.[1]).toMatchObject({ turn: 1, reason: { kind: 'completed' } })
  })
})

describe('resolveWebChatImportTitle', () => {
  it('prefers a real transcript title and falls back to the first user line', () => {
    expect(resolveWebChatImportTitle(baseTranscript([
      { role: 'user', text: 'hello world this is long enough' },
    ]))).toMatch(/^hello world/)
    expect(resolveWebChatImportTitle({
      ...baseTranscript([{ role: 'user', text: 'fallback body' }]),
      title: '虚舟命名讨论',
    })).toBe('虚舟命名讨论')
    expect(resolveWebChatImportTitle({
      ...baseTranscript([{ role: 'user', text: 'from page capture' }]),
      title: 'DeepSeek',
    })).toBe('from page capture')
  })
})

describe('buildWebChatImportSeed', () => {
  it('is a closed log the session constructor accepts', () => {
    const seed = buildWebChatImportSeed(baseTranscript([
      { role: 'user', text: 'only' },
    ]))
    const starts = seed.filter(event => event.type === 'turn/start').length
    const ends = seed.filter(event => event.type === 'turn/end').length
    expect(starts).toBe(ends)
    expect(seed.some(event => event.type === 'system/message')).toBe(true)
    expect(seed.some(event => event.type === 'session/title')).toBe(true)
    expect(seed.find(event => event.type === 'session/title')).toMatchObject({
      data: { title: 'only', source: { kind: 'fallback' } },
    })
    expect(seed.filter(event => event.type === 'turn/end').at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    expect(seed.at(-1)?.type).toBe('session/title')
    const session = Session.create(brandSessionId('session-seed-check'), seed)
    expect(session.id).toBe('session-seed-check')
  })
})

describe('importWebChatHistoryNow', () => {
  it('publishes history through agents.create seed and does not use sessions.create', async () => {
    const { create, flush, sessionCreate } = mockSeedImport()
    const transcript = {
      title: '插件灵感',
      partial: true,
      turns: [
        { role: 'user' as const, text: 'q' },
        { role: 'assistant' as const, text: 'a' },
      ],
      source: {
        kind: 'rendered-capture' as const,
        capturedAt: '2026-11-09T00:00:00.000Z',
      },
    }
    const result = await importWebChatHistoryNow({
      sessions: { flush, create: sessionCreate } as never,
      agents: { create } as never,
      workspaceId: 'ws-1',
      cwd: workspaceCwd,
      transcript,
    })
    expect(result.sessionId.startsWith('session-')).toBe(true)
    expect(sessionCreate).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    const options = create.mock.calls[0]![0]
    expect(options.meta).toEqual({ cwd: resolve(workspaceCwd) })
    expect(options.seed.some(event => event.type === 'user/message')).toBe(true)
    expect(options.seed.some(event => event.type === 'assistant/message')).toBe(true)
    expect(options.seed.some(event => event.type === 'session/title')).toBe(true)
    expect(options.seed.at(-1)).toMatchObject({
      type: 'session/title',
      data: { title: '插件灵感' },
    })
    expect(options.seed.filter(event => event.type === 'turn/start').length)
      .toBe(options.seed.filter(event => event.type === 'turn/end').length)
    expect(flush).toHaveBeenCalledWith(expect.objectContaining({ id: result.sessionId }))
  })

  it('appends on the agent session when createSession is available', async () => {
    const append = vi.fn()
    const session = { id: 'sess-cs' as const, append }
    const create = vi.fn()
    const createSession = vi.fn(async (request: { cwd: string, reusable: (id: string) => boolean }) => ({
      agent: { id: 'sess-cs' as const, session },
      request,
    }))
    const flush = vi.fn(async () => true)
    const result = await importWebChatHistoryNow({
      sessions: { flush } as never,
      agents: { createSession, create } as never,
      workspaceId: 'ws-1',
      cwd: workspaceCwd,
      transcript: baseTranscript([{ role: 'user', text: 'q' }]),
    })
    expect(result.sessionId).toBe('sess-cs')
    expect(create).not.toHaveBeenCalled()
    const request = createSession.mock.calls[0]?.[0]
    expect(request?.cwd).toBe(resolve(workspaceCwd))
    expect(request?.reusable('blank')).toBe(false)
    expect(append.mock.calls.at(-1)?.[0]).toBe('session/title')
    expect(append.mock.calls.some(call => call[0] === 'turn/end')).toBe(true)
    expect(flush).toHaveBeenCalledWith(session)
  })

  it('treats flush false as failure and disposes the agent', async () => {
    const { create, dispose, flush } = mockSeedImport()
    flush.mockResolvedValue(false)
    const attach = vi.fn(async () => undefined)
    await expect(importWebChatHistoryNow({
      sessions: { flush } as never,
      agents: { create } as never,
      workspaceId: 'ws-1',
      cwd: workspaceCwd,
      transcript: baseTranscript([{ role: 'user', text: 'q' }]),
      attachToWorkspace: attach,
    })).rejects.toMatchObject({ code: 'import-failed', sessionId: undefined })
    expect(dispose).toHaveBeenCalled()
    expect(attach).not.toHaveBeenCalled()
  })

  it('rejects empty turns', async () => {
    await expect(importWebChatHistoryNow({
      sessions: { flush: vi.fn() } as never,
      agents: {} as never,
      workspaceId: 'ws-1',
      cwd: workspaceCwd,
      transcript: baseTranscript([]),
    })).rejects.toMatchObject({ code: 'invalid-transcript' })
  })

  it('rejects message count over limit', async () => {
    const turns = Array.from({ length: WEB_CHAT_MAX_MESSAGES + 1 }, () => (
      { role: 'user' as const, text: 'x' }
    ))
    await expect(importWebChatHistoryNow({
      sessions: { flush: vi.fn() } as never,
      agents: {} as never,
      workspaceId: 'ws-1',
      cwd: workspaceCwd,
      transcript: baseTranscript(turns),
    })).rejects.toMatchObject({ code: 'invalid-transcript' })
  })

  it('rejects total text bytes over limit', async () => {
    const chunk = 'x'.repeat(1024)
    const turns = Array.from({ length: Math.ceil(WEB_CHAT_MAX_TEXT_BYTES / 1024) + 1 }, () => (
      { role: 'user' as const, text: chunk }
    ))
    await expect(importWebChatHistoryNow({
      sessions: { flush: vi.fn() } as never,
      agents: {} as never,
      workspaceId: 'ws-1',
      cwd: workspaceCwd,
      transcript: baseTranscript(turns),
    })).rejects.toMatchObject({ code: 'invalid-transcript' })
  })

  it('calls attachToWorkspace after a successful flush', async () => {
    const { create, flush } = mockSeedImport()
    const order: string[] = []
    flush.mockImplementation(async () => {
      order.push('flush')
      return true
    })
    const attach = vi.fn(async () => {
      order.push('attach')
    })
    const result = await importWebChatHistoryNow({
      sessions: { flush } as never,
      agents: { create } as never,
      workspaceId: 'ws-1',
      cwd: workspaceCwd,
      transcript: baseTranscript([{ role: 'user', text: 'q' }]),
      attachToWorkspace: attach,
    })
    expect(order).toEqual(['flush', 'attach'])
    expect(attach).toHaveBeenCalledWith(result.sessionId)
  })

  it('disposes the agent when attach fails', async () => {
    const { create, dispose, flush } = mockSeedImport()
    await expect(importWebChatHistoryNow({
      sessions: { flush } as never,
      agents: { create } as never,
      workspaceId: 'ws-1',
      cwd: workspaceCwd,
      transcript: baseTranscript([{ role: 'user', text: 'q' }]),
      attachToWorkspace: async () => {
        throw new Error('attach broke')
      },
    })).rejects.toMatchObject({ code: 'import-failed', sessionId: undefined })
    expect(dispose).toHaveBeenCalled()
  })

  it('returns sessionId on attach failure when the agent cannot be disposed', async () => {
    const append = vi.fn()
    const createSession = vi.fn(async () => ({
      agent: { id: 'sess-orphan' as const, session: { id: 'sess-orphan' as const, append } },
    }))
    await expect(importWebChatHistoryNow({
      sessions: { flush: vi.fn(async () => true) } as never,
      agents: { createSession } as never,
      workspaceId: 'ws-1',
      cwd: workspaceCwd,
      transcript: baseTranscript([{ role: 'user', text: 'q' }]),
      attachToWorkspace: async () => {
        throw new Error('no attach')
      },
    })).rejects.toMatchObject({
      code: 'import-failed',
      sessionId: 'sess-orphan',
    })
  })
})

describe('assertResolvableWorkspaceCwd', () => {
  it('accepts an existing directory', () => {
    expect(() => assertResolvableWorkspaceCwd(workspaceCwd)).not.toThrow()
  })

  it('recreates a missing directory (same as ensureResolvableWorkspaceCwd)', () => {
    const missing = join(workspaceCwd, 'missing-child')
    expect(() => assertResolvableWorkspaceCwd(missing)).not.toThrow()
    expect(assertResolvableWorkspaceCwd(missing)).toBeUndefined()
  })
})

describe('importWebChatHistoryWithContext', () => {
  it('throws no-workspace when workspace is missing', async () => {
    const ctx = new Context()
    await expect(importWebChatHistoryWithContext(ctx, {
      workspaceId: 'missing',
      transcript: baseTranscript([{ role: 'user', text: 'q' }]),
    })).rejects.toMatchObject({ code: 'no-workspace' })
    await ctx.fiber.dispose()
  })

  it('throws missing-cwd when the workspace path is a file', async () => {
    const ctx = new Context()
    const filePath = join(workspaceCwd, 'not-a-workspace-dir')
    writeFileSync(filePath, 'x')
    ctx.provide('workspaceRegistry', {
      list: () => [{ id: 'ws-file', title: 'File', path: filePath }],
      get: () => ({ id: 'ws-file', title: 'File', path: filePath }),
    } as never)
    ctx.provide('sessions', { flush: vi.fn(async () => true) } as never)
    ctx.provide('agents', { create: vi.fn() } as never)
    await expect(importWebChatHistoryWithContext(ctx, {
      workspaceId: 'ws-file',
      transcript: baseTranscript([{ role: 'user', text: 'q' }]),
    })).rejects.toMatchObject({ code: 'missing-cwd' })
    await ctx.fiber.dispose()
  })

  it('fails when the agent registry cannot create a session', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', {
      list: () => [{ id: 'ws-1', title: 'P', path: workspaceCwd }],
      get: () => ({ id: 'ws-1', title: 'P', path: workspaceCwd }),
    } as never)
    ctx.provide('sessions', { flush: vi.fn(async () => true) } as never)
    await expect(importWebChatHistoryWithContext(ctx, {
      workspaceId: 'ws-1',
      transcript: baseTranscript([{ role: 'user', text: 'q' }]),
    })).rejects.toMatchObject({ code: 'import-failed' })
    await ctx.fiber.dispose()
  })

  it('imports through agents.create and attaches the workspace', async () => {
    const ctx = new Context()
    const attach = vi.fn(async () => undefined)
    const create = vi.fn(async (options: {
      sessionId: string
      seed: readonly { type: string }[]
      meta: { cwd: string }
      agentOptions?: { provider?: string }
    }) => ({
      agent: { id: options.sessionId, session: { id: options.sessionId, append: vi.fn() } },
      dispose: vi.fn(async () => undefined),
    }))
    ctx.provide('workspaceRegistry', {
      list: () => [{ id: 'ws-1', title: 'P', path: workspaceCwd }],
      get: () => ({ id: 'ws-1', title: 'P', path: workspaceCwd, attachSession: attach }),
    } as never)
    ctx.provide('sessions', { flush: vi.fn(async () => true) } as never)
    ctx.provide('agents', { create } as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek', model: 'chat' }),
    } as never)
    const result = await importWebChatHistoryWithContext(ctx, {
      workspaceId: 'ws-1',
      transcript: baseTranscript([{ role: 'user', text: 'q' }]),
    })
    expect(create).toHaveBeenCalledTimes(1)
    const options = create.mock.calls[0]![0]
    expect(options.seed.at(-1)?.type).toBe('session/title')
    expect(options.meta.cwd).toBe(resolve(workspaceCwd))
    expect(options.agentOptions?.provider).toBe('deepseek')
    expect(attach).toHaveBeenCalledWith(result.sessionId)
    await ctx.fiber.dispose()
  })
})

describe('listWebChatWorkspacesNow', () => {
  it('reads workspaceRegistry list', () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', {
      list: () => [{
        id: 'ws-a',
        title: 'Proj',
        path: workspaceCwd,
        sessionIds: [],
      }],
    } as never)
    expect(listWebChatWorkspacesNow(ctx)).toEqual([{
      id: 'ws-a',
      title: 'Proj',
      cwd: resolve(workspaceCwd),
    }])
  })

  it('falls back to storageDomain table when registry is empty', () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    ctx.provide('storageDomain', {
      get: () => ({
        table: () => ({
          entries: () => [['ws-b', { title: 'B', cwd: 'D:/work' }]] as const,
        }),
      }),
    } as never)
    expect(listWebChatWorkspacesNow(ctx)).toEqual([{
      id: 'ws-b',
      title: 'B',
      cwd: resolve('D:/work'),
    }])
  })
})

describe('webChatImportToRemoteError', () => {
  it('exposes webChatCode in RemoteError details', () => {
    const remote = webChatImportToRemoteError(
      new WebChatImportError('invalid-transcript', 'bad turns'),
    )
    expect(remote.message).toMatch(/^invalid-transcript:/)
    expect(remote.details).toMatchObject({
      code: 'FILE_EDIT_FAILED',
      webChatCode: 'invalid-transcript',
    })
  })

  it('includes sessionId when dispose failed after attach error', () => {
    const remote = webChatImportToRemoteError(
      new WebChatImportError('import-failed', 'attach failed', 'sess-orphan' as never),
    )
    expect(remote.details).toMatchObject({
      webChatCode: 'import-failed',
      sessionId: 'sess-orphan',
    })
  })
})
