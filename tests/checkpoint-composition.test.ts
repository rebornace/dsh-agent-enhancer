import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, SessionStore } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ readFile: vi.fn() }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const readFile = ((...args: unknown[]) => {
    io.readFile(...args)
    return Reflect.apply(actual.readFile, undefined, args)
  }) as unknown as typeof actual.readFile
  return { ...actual, readFile }
})
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
  vi.restoreAllMocks()
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

  expect(register).toHaveBeenCalledTimes(1)
  expect(register).toHaveBeenCalledWith(hostContribution)
  expect(hostContribution.invocations).toEqual(
    expect.arrayContaining([...checkpointHostContribution.invocations]),
  )
  expect(ctx.checkpointRollback).toBeInstanceOf(CheckpointRollbackRemoteService)
  await ctx.fiber.dispose()
  expect(unregister).toHaveBeenCalledTimes(1)
})

async function captureFixture(
  enabled: boolean,
  prepare?: (value: { store: CheckpointStore, session: Session, workspaceRoot: string }) => Promise<void>,
) {
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
  const store = new CheckpointStore(join(
    directory, 'profiles', 'desktop', 'plugin-data', 'dsh-agent-enhancer', 'checkpoint',
  ))
  await prepare?.({ store, session, workspaceRoot })
  apply(ctx, Config({ rollbackEnabled: enabled }))
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

async function runFileTurn(
  h: Awaited<ReturnType<typeof captureFixture>>,
  turn = 2,
  paths: readonly string[] = ['note.txt'],
) {
  const prompt = {
    id: MessageId(`user-${turn}`), role: 'user' as const,
    content: [{ type: 'text' as const, text: `prompt ${turn}` }], source: { kind: 'user' as const },
  }
  await h.ctx.waterfall('agent/pre-step', {
    agent: h.agent, messages: [prompt], turn, step: 0, signal: new AbortController().signal,
  } as never, async () => ({ kind: 'enter', messages: [prompt] }))
  h.session.append('turn/start', { turn })
  appendUser(h.session, turn, `prompt ${turn}`)
  for (const path of paths) {
    const absolutePath = join(h.workspaceRoot, path)
    const target = { absolutePath, displayPath: absolutePath }
    const exec = {
      agent: h.agent,
      name: 'write_file',
      arguments: { path },
      signal: new AbortController().signal,
    }
    await h.ctx.waterfall('tools/execute', exec as never, async () => {
      await h.ctx.waterfall('fs/write-intent', target as never, exec, () => undefined)
      await writeFile(absolutePath, `after ${turn}`, 'utf8')
      return { value: null, content: [], isError: false }
    })
  }
  await h.ctx.waterfall('agent/pre-step', {
    agent: h.agent, messages: [], turn, step: 1, signal: new AbortController().signal,
  } as never, async () => ({ kind: 'enter', messages: [] }))
  h.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

async function setRollbackEnabled(ctx: Context, enabled: boolean) {
  // Cordis 4.1: waterfall(fiber, 'internal/update', config, next) binds `this` to the
  // Fiber. Pass a no-op next so listeners run without Fiber.update()'s restart
  // (which would detach SessionStore sessions on this shared fixture fiber).
  await (ctx.waterfall as (thisArg: unknown, name: string, ...args: unknown[]) => Promise<unknown>)(
    ctx.fiber,
    'internal/update',
    Config({ rollbackEnabled: enabled }),
    () => {},
  )
}

it('recovers a persisted surface append during Host startup without a preview call', async () => {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const h = await captureFixture(false, async ({ store, session, workspaceRoot }) => {
    const storageRoot = join(
      process.env.DSH_HOME!, 'profiles', 'desktop', 'plugin-data', 'dsh-agent-enhancer', 'checkpoint',
    )
    await writeFile(join(workspaceRoot, 'file.txt'), 'before', 'utf8')
    session.append('turn/start', { turn: 1 })
    appendUser(session, 1, 'prompt')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const sourceSeq = session.surface.nodes[0]!
    session.append('user/message', {
      id: MessageId('dsh-agent-enhancer:rollback:1:startup-restore'),
      role: 'user',
      content: [{ type: 'text', text: 'Rollback notice' }],
      source: { kind: 'checkpoint-rollback', form: 'notice', summary: 'Rolled back before turn 1' },
    }, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(sourceSeq), endSeq: SessionSeq(sourceSeq) },
      sourceEventSeqs: [SessionSeq(sourceSeq)],
    })
    await store.beginJournal({
      schemaVersion: 1,
      id: 'startup-restore',
      sessionId: session.id,
      checkpointId: 'checkpoint-startup',
      status: 'files-restored',
      createdAt: 1,
    })
    const directory = join(storageRoot, 'file-journals')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${digest('startup-restore')}.json`), JSON.stringify({
      schemaVersion: 1,
      id: 'startup-restore',
      snapshots: [{
        path: 'file.txt',
        exists: true,
        text: 'after',
        afterHash: digest('after'),
        beforeHash: digest('before'),
      }],
      completed: ['file.txt'],
    }), 'utf8')
  })

  await vi.waitFor(async () => {
    expect(await h.store.recoverJournal()).toEqual([])
  })
  await expect(readFile(join(h.workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
  expect(h.session.surface.nodes).toEqual([h.session.snapshotEvents().at(-1)!.seq])
})

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
    expect((await h.store.list(h.session.id)).some(item => item.turn === 2)).toBe(true)
  })
  const checkpoint = (await h.store.list(h.session.id)).find(item => item.turn === 2)
  expect(checkpoint).toMatchObject({
    sessionId: h.session.id,
    turn: 2,
    atSeq: 2,
    prompt: 'prompt 2',
    coverage: 'complete',
    files: [{ path: 'note.txt', change: 'modify', beforeText: 'before', afterText: 'after 2' }],
  })
  expect(checkpoint!.files[0]!.beforeHash).not.toBe(checkpoint!.files[0]!.afterHash)
  const beforeUnload = (await h.store.list(h.session.id)).length

  // 0.2.2 SessionStore detaches sessions when its owning fiber disposes, so
  // post-unload appends are illegal on this shared fixture fiber. Unload still
  // must leave persisted checkpoints intact.
  await h.ctx.fiber.dispose()
  expect(await h.store.list(h.session.id)).toHaveLength(beforeUnload)
})

it('follows runtime enable, disable, and re-enable in one Context without relying on initial config', async () => {
  const h = await captureFixture(false)
  h.session.append('turn/start', { turn: 1 })
  appendUser(h.session, 1, 'first prompt')
  h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await writeFile(join(h.workspaceRoot, 'note.txt'), 'before', 'utf8')

  await setRollbackEnabled(h.ctx, true)
  await runFileTurn(h, 2)
  await vi.waitFor(async () => {
    expect(await h.store.list(h.session.id)).toHaveLength(1)
  })

  await setRollbackEnabled(h.ctx, false)
  await runFileTurn(h, 3)
  await Promise.resolve()
  expect(await h.store.list(h.session.id)).toHaveLength(1)

  await setRollbackEnabled(h.ctx, true)
  await runFileTurn(h, 4)
  await vi.waitFor(async () => {
    expect(await h.store.list(h.session.id)).toHaveLength(2)
  })
  expect((await h.store.list(h.session.id)).map(checkpoint => checkpoint.turn)).toEqual([2, 4])
})

it('still captures creates when write-intent policy owns the slot without calling next', async () => {
  const h = await captureFixture(true)
  // Mimic dsh-fs-observation-policy: first decision listener returns and never next().
  h.ctx.on('fs/write-intent', async () => ({ kind: 'createIfAbsent' as const }))

  h.session.append('turn/start', { turn: 1 })
  appendUser(h.session, 1, 'first prompt')
  h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const prompt = {
    id: MessageId('user-2'), role: 'user' as const,
    content: [{ type: 'text' as const, text: 'prompt 2' }], source: { kind: 'user' as const },
  }
  await h.ctx.waterfall('agent/pre-step', {
    agent: h.agent, messages: [prompt], turn: 2, step: 0, signal: new AbortController().signal,
  } as never, async () => ({ kind: 'enter', messages: [prompt] }))
  h.session.append('turn/start', { turn: 2 })
  appendUser(h.session, 2, 'prompt 2')

  const blankPath = join(h.workspaceRoot, 'blank.txt')
  const writeTarget = { absolutePath: blankPath, displayPath: blankPath }
  const writeExec = {
    agent: h.agent,
    name: 'write',
    arguments: { file_path: 'blank.txt', content: '' },
    signal: new AbortController().signal,
  }
  await h.ctx.waterfall('tools/execute', writeExec as never, async () => {
    // Policy owns the slot; our prepended capture must still have run via tools/execute args.
    const intent = await h.ctx.waterfall('fs/write-intent', writeTarget as never, writeExec, () => undefined)
    expect(intent).toEqual({ kind: 'createIfAbsent' })
    await writeFile(blankPath, '', { encoding: 'utf8', flag: 'wx' })
    return { value: null, content: [], isError: false }
  })
  h.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

  await vi.waitFor(async () => {
    expect((await h.store.list(h.session.id)).some(item => item.turn === 2)).toBe(true)
  })
  const checkpoint = (await h.store.list(h.session.id)).find(item => item.turn === 2)
  expect(checkpoint).toMatchObject({
    turn: 2,
    files: [{
      path: 'blank.txt',
      change: 'create',
      beforeText: null,
      afterText: '',
    }],
  })
})

it('captures empty creates from write-intent actor.agent when tools/execute never ran', async () => {
  // Desktop scopes tools/execute to the agent carrier; a non-global host listener
  // never populates the actors WeakMap. Capture must still read exec.agent.
  const h = await captureFixture(true)
  h.ctx.on('fs/write-intent', async () => ({ kind: 'createIfAbsent' as const }))

  const prompt = {
    id: MessageId('user-2'), role: 'user' as const,
    content: [{ type: 'text' as const, text: 'create blank' }], source: { kind: 'user' as const },
  }
  await h.ctx.waterfall('agent/pre-step', {
    agent: h.agent, messages: [prompt], turn: 2, step: 0, signal: new AbortController().signal,
  } as never, async () => ({ kind: 'enter', messages: [prompt] }))
  h.session.append('turn/start', { turn: 2 })
  appendUser(h.session, 2, 'create blank')

  const blankPath = join(h.workspaceRoot, 'blank.txt')
  const writeTarget = { absolutePath: blankPath, displayPath: blankPath }
  const writeExec = {
    agent: h.agent,
    name: 'write',
    arguments: { file_path: 'blank.txt', content: '' },
    signal: new AbortController().signal,
  }
  const intent = await h.ctx.waterfall('fs/write-intent', writeTarget as never, writeExec, () => undefined)
  expect(intent).toEqual({ kind: 'createIfAbsent' })
  await writeFile(blankPath, '', { encoding: 'utf8', flag: 'wx' })
  h.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

  await vi.waitFor(async () => {
    expect((await h.store.list(h.session.id)).some(item => item.turn === 2)).toBe(true)
  })
  const checkpoint = (await h.store.list(h.session.id)).find(item => item.turn === 2)
  expect(checkpoint).toMatchObject({
    turn: 2,
    files: [{
      path: 'blank.txt',
      change: 'create',
      beforeText: null,
      afterText: '',
    }],
  })
})

it('keeps empty write creates when the same turn also uses a no-op shell', async () => {
  const h = await captureFixture(true)
  h.session.append('turn/start', { turn: 1 })
  appendUser(h.session, 1, 'first prompt')
  h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const prompt = {
    id: MessageId('user-2'), role: 'user' as const,
    content: [{ type: 'text' as const, text: 'prompt 2' }], source: { kind: 'user' as const },
  }
  await h.ctx.waterfall('agent/pre-step', {
    agent: h.agent, messages: [prompt], turn: 2, step: 0, signal: new AbortController().signal,
  } as never, async () => ({ kind: 'enter', messages: [prompt] }))
  h.session.append('turn/start', { turn: 2 })
  appendUser(h.session, 2, 'prompt 2')

  const blankPath = join(h.workspaceRoot, 'blank.txt')
  const writeTarget = { absolutePath: blankPath, displayPath: blankPath }
  const writeExec = {
    agent: h.agent,
    name: 'write',
    arguments: { file_path: 'blank.txt', content: '' },
    signal: new AbortController().signal,
  }
  await h.ctx.waterfall('tools/execute', writeExec as never, async () => {
    await h.ctx.waterfall('fs/write-intent', writeTarget as never, writeExec, () => undefined)
    await writeFile(blankPath, '', { encoding: 'utf8', flag: 'wx' })
    return { value: null, content: [], isError: false }
  })

  const shellExec = {
    agent: h.agent,
    name: 'bash',
    arguments: { command: 'ls' },
    signal: new AbortController().signal,
  }
  await h.ctx.waterfall('tools/execute', shellExec as never, async () => ({
    value: null, content: [], isError: false,
  }))

  h.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

  await vi.waitFor(async () => {
    expect((await h.store.list(h.session.id)).some(item => item.turn === 2)).toBe(true)
  })
  const checkpoint = (await h.store.list(h.session.id)).find(item => item.turn === 2)
  // No-op shell scan succeeds — no forced workspace gap.
  expect(checkpoint).toMatchObject({
    turn: 2,
    coverage: 'complete',
    gaps: [],
    files: [{
      path: 'blank.txt',
      change: 'create',
      beforeText: null,
      afterText: '',
    }],
  })
  expect(checkpoint!.files[0]!.beforeHash).toBe('')
  expect(checkpoint!.files[0]!.afterHash).toBe(createHash('sha256').update('').digest('hex'))
})

it('captures pwsh Set-Content style creates via workspace before/after scan', async () => {
  const h = await captureFixture(true)
  const prompt = {
    id: MessageId('user-2'), role: 'user' as const,
    content: [{ type: 'text' as const, text: 'create via pwsh' }], source: { kind: 'user' as const },
  }
  await h.ctx.waterfall('agent/pre-step', {
    agent: h.agent, messages: [prompt], turn: 2, step: 0, signal: new AbortController().signal,
  } as never, async () => ({ kind: 'enter', messages: [prompt] }))
  h.session.append('turn/start', { turn: 2 })
  appendUser(h.session, 2, 'create via pwsh')

  const created = join(h.workspaceRoot, '111.txt')
  const shellExec = {
    agent: h.agent,
    name: 'pwsh',
    arguments: { command: "Set-Content -Path '.\\\\111.txt' -Value $null -NoNewline" },
    signal: new AbortController().signal,
  }
  await h.ctx.waterfall('tools/execute', shellExec as never, async () => {
    await writeFile(created, '', { encoding: 'utf8', flag: 'wx' })
    return { value: null, content: [], isError: false }
  })
  h.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

  await vi.waitFor(async () => {
    expect((await h.store.list(h.session.id)).some(item => item.turn === 2)).toBe(true)
  })
  const checkpoint = (await h.store.list(h.session.id)).find(item => item.turn === 2)
  expect(checkpoint).toMatchObject({
    turn: 2,
    coverage: 'complete',
    gaps: [],
    files: [{
      path: '111.txt',
      change: 'create',
      beforeText: null,
      afterText: '',
    }],
  })
})

it('does not mark a no-op shell turn incomplete or invent file rows', async () => {
  const h = await captureFixture(true)
  await writeFile(join(h.workspaceRoot, 'keep.txt'), 'stable', 'utf8')
  const prompt = {
    id: MessageId('user-2'), role: 'user' as const,
    content: [{ type: 'text' as const, text: 'list only' }], source: { kind: 'user' as const },
  }
  await h.ctx.waterfall('agent/pre-step', {
    agent: h.agent, messages: [prompt], turn: 2, step: 0, signal: new AbortController().signal,
  } as never, async () => ({ kind: 'enter', messages: [prompt] }))
  h.session.append('turn/start', { turn: 2 })
  appendUser(h.session, 2, 'list only')

  await h.ctx.waterfall('tools/execute', {
    agent: h.agent,
    name: 'pwsh',
    arguments: { command: 'Get-ChildItem' },
    signal: new AbortController().signal,
  } as never, async () => ({ value: null, content: [], isError: false }))

  h.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

  await vi.waitFor(async () => {
    expect((await h.store.list(h.session.id)).some(item => item.turn === 2)).toBe(true)
  })
  const checkpoint = (await h.store.list(h.session.id)).find(item => item.turn === 2)
  expect(checkpoint).toMatchObject({
    turn: 2,
    coverage: 'complete',
    gaps: [],
    files: [],
  })
})

it('ignores unattributed fs intents so an open turn stays file-restorable', async () => {
  const h = await captureFixture(true)
  await writeFile(join(h.workspaceRoot, 'note.txt'), 'before', 'utf8')
  const prompt = {
    id: MessageId('user-2'), role: 'user' as const,
    content: [{ type: 'text' as const, text: 'prompt 2' }], source: { kind: 'user' as const },
  }
  await h.ctx.waterfall('agent/pre-step', {
    agent: h.agent, messages: [prompt], turn: 2, step: 0, signal: new AbortController().signal,
  } as never, async () => ({ kind: 'enter', messages: [prompt] }))
  h.session.append('turn/start', { turn: 2 })
  appendUser(h.session, 2, 'prompt 2')

  // Stray write with no tools/execute actor must not mark the pending turn incomplete.
  const stray = { absolutePath: join(h.workspaceRoot, 'note.txt'), displayPath: join(h.workspaceRoot, 'note.txt') }
  await h.ctx.waterfall('fs/write-intent', stray as never, undefined, () => undefined)

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
    await writeFile(absolutePath, 'after 2', 'utf8')
    return { value: null, content: [], isError: false }
  })
  h.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

  await vi.waitFor(async () => {
    expect(await h.store.list(h.session.id)).toHaveLength(1)
  })
  const [checkpoint] = await h.store.list(h.session.id)
  expect(checkpoint).toMatchObject({
    turn: 2,
    coverage: 'complete',
    gaps: [],
    files: [expect.objectContaining({ path: 'note.txt', change: 'modify' })],
  })
})

it('never reads or saves excluded file contents during live capture', async () => {
  const h = await captureFixture(true)
  h.session.append('turn/start', { turn: 1 })
  appendUser(h.session, 1, 'first prompt')
  h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const paths = ['.env', '.git/config', 'node_modules/pkg/index.js'] as const
  const secrets = ['ENV_SECRET_VALUE', 'GIT_SECRET_VALUE', 'NODE_MODULES_SECRET_VALUE'] as const
  await mkdir(join(h.workspaceRoot, '.git'), { recursive: true })
  await mkdir(join(h.workspaceRoot, 'node_modules/pkg'), { recursive: true })
  for (const [index, path] of paths.entries()) {
    await writeFile(join(h.workspaceRoot, path), secrets[index]!, 'utf8')
  }
  const read = io.readFile

  await runFileTurn(h, 2, paths)

  await vi.waitFor(async () => {
    expect(await h.store.list(h.session.id)).toHaveLength(1)
  })
  const [checkpoint] = await h.store.list(h.session.id)
  expect(checkpoint).toMatchObject({ coverage: 'complete', files: [] })
  const serialized = JSON.stringify(checkpoint)
  for (const [index, path] of paths.entries()) {
    expect(serialized).not.toContain(secrets[index]!)
    expect(read.mock.calls.filter(call => String(call[0]) === join(h.workspaceRoot, path))).toEqual([])
  }
})
