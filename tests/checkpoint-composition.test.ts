import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { CheckpointStore } from '../src/host/checkpoint/store.ts'
import {
  apply,
  CheckpointRollbackRemoteService,
  Config,
  checkpointHostContribution,
  hostContribution,
} from '../src/host/index.ts'

const contexts: Context[] = []
const temporaryDirectories: string[] = []
const previousDshHome = process.env.DSH_HOME

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

it('assembles the guarded rollback service beside the model Remote and disposes both contributions', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const unregister = vi.fn()
  const register = vi.fn(() => unregister)
  ctx.provide('llm', {} as never)
  ctx.provide('sessions', { get: vi.fn() } as never)
  ctx.provide('agents', { get: vi.fn() } as never)
  ctx.provide('sessionProjections', { stateOf: vi.fn(), snapshot: vi.fn() } as never)
  ctx.provide('agentDefaultModel', { currentSelection: vi.fn() } as never)
  ctx.provide('typert', { register } as never)
  ctx.provide('fs', {} as never)
  ctx.provide('tools', {} as never)

  apply(ctx, Config({ rollbackEnabled: false }))

  expect(register).toHaveBeenCalledWith(hostContribution)
  expect(register).toHaveBeenCalledWith(checkpointHostContribution)
  expect(ctx.checkpointRollback).toBeInstanceOf(CheckpointRollbackRemoteService)
  await ctx.fiber.dispose()
  expect(unregister).toHaveBeenCalledTimes(2)
})

async function captureFixture(enabled: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-composition-'))
  temporaryDirectories.push(directory)
  process.env.DSH_HOME = directory
  const workspaceRoot = await mkdtemp(join(directory, 'workspace-'))
  const ctx = new Context()
  contexts.push(ctx)
  const sessions = new SessionStore(ctx)
  const session = sessions.create('session-capture' as SessionId, { meta: { cwd: workspaceRoot } })
  const agent = {
    id: session.id,
    session,
    status: 'idle' as const,
    runMaintenance: async <T,>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
  }
  ctx.provide('llm', {} as never)
  ctx.provide('agents', { get: () => agent } as never)
  ctx.provide('sessionProjections', { stateOf: vi.fn(), snapshot: vi.fn() } as never)
  ctx.provide('agentDefaultModel', { currentSelection: vi.fn() } as never)
  ctx.provide('typert', { register: () => () => {} } as never)
  ctx.provide('fs', { processPath: (target: { absolutePath: string }) => target.absolutePath } as never)
  ctx.provide('tools', {} as never)
  apply(ctx, Config({ rollbackEnabled: enabled }))
  const store = new CheckpointStore(join(
    directory, 'profiles', 'desktop', 'plugin-data', 'dsh-composer-enhancer', 'checkpoint',
  ))
  return { ctx, sessions, session, agent, workspaceRoot, store }
}

function appendUser(session: Session, turn: number, text: string) {
  session.append('user/message', {
    id: MessageId(`user-${turn}`),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
}

async function runFileTurn(h: Awaited<ReturnType<typeof captureFixture>>) {
  const prompt = {
    id: MessageId('user-2'), role: 'user' as const,
    content: [{ type: 'text' as const, text: 'second prompt' }], source: { kind: 'user' as const },
  }
  await h.ctx.waterfall('agent/pre-step', {
    agent: h.agent, messages: [prompt], turn: 2, step: 0, signal: new AbortController().signal,
  } as never, async () => ({ kind: 'enter', messages: [prompt] }))
  h.session.append('turn/start', { turn: 2 })
  appendUser(h.session, 2, 'second prompt')
  const absolutePath = join(h.workspaceRoot, 'note.txt')
  const target = { absolutePath, displayPath: absolutePath }
  const exec = {
    agent: h.agent,
    name: 'write_file',
    arguments: { path: 'note.txt' },
    signal: new AbortController().signal,
  }
  await h.ctx.waterfall('tools/execute', exec as never, async () => {
    await h.ctx.waterfall('fs/write-intent', target as never, exec, () => undefined)
    await writeFile(absolutePath, 'after', 'utf8')
    return { value: null, content: [], isError: false }
  })
  await h.ctx.waterfall('agent/pre-step', {
    agent: h.agent, messages: [], turn: 2, step: 1, signal: new AbortController().signal,
  } as never, async () => ({ kind: 'enter', messages: [] }))
  h.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
}

it('captures a real turn and file before-image only after the independent switch is enabled', async () => {
  const disabled = await captureFixture(false)
  disabled.session.append('turn/start', { turn: 1 })
  appendUser(disabled.session, 1, 'first prompt')
  disabled.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await expect(disabled.store.list(disabled.session.id)).resolves.toEqual([])
  await disabled.ctx.fiber.dispose()

  const h = await captureFixture(true)
  h.session.append('turn/start', { turn: 1 })
  appendUser(h.session, 1, 'first prompt')
  h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await writeFile(join(h.workspaceRoot, 'note.txt'), 'before', { encoding: 'utf8', flag: 'wx' })

  await runFileTurn(h)

  await vi.waitFor(async () => {
    expect(await h.store.list(h.session.id)).toHaveLength(1)
  })
  const [checkpoint] = await h.store.list(h.session.id)
  expect(checkpoint).toMatchObject({
    sessionId: h.session.id,
    turn: 2,
    atSeq: 2,
    prompt: 'second prompt',
    coverage: 'complete',
    files: [{ path: 'note.txt', change: 'modify', beforeText: 'before' }],
  })
  expect(checkpoint!.files[0]!.beforeHash).not.toBe(checkpoint!.files[0]!.afterHash)

  await h.ctx.fiber.dispose()
  h.session.append('turn/start', { turn: 3 })
  appendUser(h.session, 3, 'after unload')
  h.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
  await Promise.resolve()
  expect(await h.store.list(h.session.id)).toHaveLength(1)
})
