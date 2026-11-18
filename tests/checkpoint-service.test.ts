import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyCheckpointRollback, CheckpointRollbackRemoteService, checkpointHostContribution } from '../src/host/index.ts'
import { checkpointRemoteInfo, checkpointRollbackRequestSchema } from '../src/host/rpc.ts'
import { CheckpointFiles } from '../src/host/checkpoint/files.ts'
import type { CheckpointFileOperations } from '../src/host/checkpoint/files.ts'
import { deriveMessagesWithCut } from '../src/host/checkpoint/cut-filter.ts'
import { SessionCutStore } from '../src/host/checkpoint/cut-store.ts'
import { CheckpointRollbackService } from '../src/host/checkpoint/service.ts'
import type {
  CheckpointRollbackServiceOptions,
  CheckpointServiceSession,
} from '../src/host/checkpoint/service.ts'
import { CheckpointStore } from '../src/host/checkpoint/store.ts'
import type { Checkpoint, FileCheckpoint } from '../src/host/checkpoint/types.ts'

const roots: string[] = []
const services: CheckpointRollbackService[] = []
const contexts: Context[] = []
const sessionId = SessionId('session-1')
let root: string
let workspaceRoot: string
let storageRoot: string

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function fileCheckpoint(
  path: string,
  change: FileCheckpoint['change'],
  beforeText: string | null,
  afterText: string | null,
): FileCheckpoint {
  return {
    path,
    change,
    beforeText,
    beforeHash: beforeText === null ? '' : digest(beforeText),
    afterText,
    afterHash: afterText === null ? '' : digest(afterText),
  }
}

function makeSession(origin?: 'subagent'): Session {
  return Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    isSeeded: false,
    ...(origin === undefined ? {} : { origin }),
  }, SessionLogOffset(0))
}

function appendSystem(session: Session): void {
  session.append('system/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId('system'),
      role: 'system',
      content: [{ type: 'text', text: 'system' }],
      source: { kind: 'system-prompt' },
    },
  }, { surfaceOp: 'append' })
}

function appendTurn(session: Session, turn: number, prompt: string, answer: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', {
    id: MessageId(`user-${turn}`),
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 0,
    message: {
      id: MessageId(`assistant-${turn}`),
      role: 'assistant',
      content: [{ type: 'text', text: answer }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    },
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function appendTurnWithTool(
  session: Session,
  turn: number,
  prompt: string,
  callId: string,
  toolOutput: string,
  answer: string,
): void {
  const step = 1
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  session.append('user/message', {
    id: MessageId(`user-${turn}`),
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  const toolCallId = ToolCallId(callId)
  session.append('assistant/message', {
    turn,
    step,
    message: {
      id: MessageId(`assistant-${turn}-call`),
      role: 'assistant',
      content: [{
        type: 'tool-call',
        id: toolCallId,
        name: 'test-tool',
        arguments: '{"ok":true}',
      }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    },
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('tool/call', {
    turn,
    step,
    callId: toolCallId,
    name: 'test-tool',
    arguments: '{"ok":true}',
  })
  session.append('tool/result', {
    turn,
    step,
    message: {
      id: MessageId(`tool-${turn}`),
      role: 'tool',
      source: { kind: 'tool', callId: toolCallId },
      toolCallId,
      content: [{ type: 'text', text: toolOutput }],
    },
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step,
    message: {
      id: MessageId(`assistant-${turn}`),
      role: 'assistant',
      content: [{ type: 'text', text: answer }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    },
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    schemaVersion: 1,
    pluginVersion: '0.2.0',
    id: 'checkpoint-2',
    sessionId,
    session: { format: SESSION_FORMAT_VERSION, preset: null },
    turn: 2,
    atSeq: 5,
    prompt: 'second prompt',
    createdAt: 100,
    stage: 'committed',
    coverage: 'complete',
    gaps: [],
    files: [fileCheckpoint('file.txt', 'modify', 'before', 'after')],
    ...overrides,
  }
}

interface Harness {
  service: CheckpointRollbackService
  store: CheckpointStore
  cuts: SessionCutStore
  session: Session
  adapter: CheckpointServiceSession
  setStatus(status: 'idle' | 'running'): void
  setPermission(allowed: boolean): void
  setCurrent(adapter: CheckpointServiceSession): void
  setEnabled(enabled: boolean): void
}

function harness(options: {
  session?: Session
  seedTurns?: boolean
  operations?: CheckpointFileOperations
  synchronize?: (signal: AbortSignal) => Promise<void>
  createId?: () => string
} = {}): Harness {
  const session = options.session ?? makeSession()
  if (options.seedTurns !== false) {
    appendSystem(session)
    appendTurn(session, 1, 'first prompt', 'first answer')
    appendTurn(session, 2, 'second prompt', 'second answer')
    // Later turn so restore-before-2 withdraws both tip and remainder (peel tests).
    appendTurn(session, 3, 'third prompt', 'third answer')
  }
  const store = new CheckpointStore(storageRoot)
  let status: 'idle' | 'running' = 'idle'
  let allowed = true
  let enabled = true
  let current: CheckpointServiceSession
  const adapter: CheckpointServiceSession = {
    session,
    workspaceRoot,
    get status() { return status },
    get canRestore() { return allowed },
    readEvents: () => session.snapshotEvents(),
    runMaintenance: task => task(new AbortController().signal),
    synchronize: options.synchronize ?? (async () => {}),
  }
  current = adapter
  const cuts = new SessionCutStore(join(storageRoot, 'cuts'))
  const cutCache = new Map<typeof sessionId, Awaited<ReturnType<SessionCutStore['get']>>>()
  const nativeDerive = session.deriveMessages.bind(session)
  session.deriveMessages = () => {
    const cut = cutCache.get(session.id as typeof sessionId)
    if (cut === undefined || cut === null) return nativeDerive()
    return deriveMessagesWithCut(session, cut)
  }
  const serviceOptions: CheckpointRollbackServiceOptions = {
    store,
    storageRoot,
    pluginVersion: '0.2.0',
    resolveSession: id => id === current.session.id ? current : undefined,
    isEnabled: () => enabled,
    operations: options.operations,
    createId: options.createId,
    cutStore: cuts,
    cutCache,
  }
  const service = new CheckpointRollbackService(serviceOptions)
  services.push(service)
  return {
    service,
    store,
    cuts,
    session,
    adapter,
    setStatus(value) { status = value },
    setPermission(value) { allowed = value },
    setCurrent(value) { current = value },
    setEnabled(value) { enabled = value },
  }
}

async function seedCheckpoint(h: Harness, value = checkpoint()): Promise<void> {
  await h.store.save(value)
  await writeFile(join(workspaceRoot, 'file.txt'), 'after', 'utf8')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-service-'))
  roots.push(root)
  workspaceRoot = join(root, 'workspace')
  storageRoot = join(root, 'storage')
  await mkdir(workspaceRoot, { recursive: true })
})

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()))
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

describe('CheckpointRollbackService preview', () => {
  it('recomputes surface messages, files, and current hashes for every preview', async () => {
    const h = harness()
    await seedCheckpoint(h)
    expect(h.adapter.readEvents().map(event => [event.seq, event.type])).toEqual([
      [0, 'session/end-seed'], [1, 'system/message'], [2, 'turn/start'], [3, 'user/message'], [4, 'assistant/message'],
      [5, 'turn/end'], [6, 'turn/start'], [7, 'user/message'], [8, 'assistant/message'], [9, 'turn/end'],
      [10, 'turn/start'], [11, 'user/message'], [12, 'assistant/message'], [13, 'turn/end'],
    ])
    expect(h.session.surface.nodes).toEqual([1, 3, 4, 7, 8, 11, 12])

    const first = await h.service.preview({ sessionId, turn: 2 })
    expect(first).toMatchObject({
      sessionId,
      turn: 2,
      messages: [
        { seq: 7, type: 'user/message', text: 'second prompt' },
        { seq: 8, type: 'assistant/message', text: 'second answer' },
        { seq: 11, type: 'user/message', text: 'third prompt' },
        { seq: 12, type: 'assistant/message', text: 'third answer' },
      ],
      files: [{ path: 'file.txt', change: 'modify' }],
      conflicts: [],
      unavailable: [],
    })

    await writeFile(join(workspaceRoot, 'file.txt'), 'external edit', 'utf8')
    const second = await h.service.preview({ sessionId, turn: 2 })
    expect(second.conflicts).toEqual([{
      path: 'file.txt',
      reason: 'hash-mismatch',
      expectedHash: digest('after'),
      actualHash: digest('external edit'),
    }])
  })

  it.each([
    { name: 'running Session', setup: (h: Harness) => { h.setStatus('running') }, reason: 'session-running' },
    { name: 'missing restore permission', setup: (h: Harness) => { h.setPermission(false) }, reason: 'permission-denied' },
    { name: 'disabled rollback', setup: (h: Harness) => { h.setEnabled(false) }, reason: 'rollback-disabled' },
  ])('reports $name as unavailable without writing', async ({ setup, reason }) => {
    const h = harness()
    await seedCheckpoint(h)
    setup(h)
    const initialSeq = h.session.seq

    const preview = await h.service.preview({ sessionId, turn: 2 })

    expect(preview.unavailable).toContain(reason)
    expect(h.session.seq).toBe(initialSeq)
    await expect(h.service.execute({ sessionId, turn: 2 })).rejects.toMatchObject({ code: 'ROLLBACK_UNAVAILABLE' })
  })

  it('allows conversation restore before turn 1 when atSeq is after the system message', async () => {
    const h = harness()
    // session/end-seed@0, system@1, turn/start@2 → capture stores atSeq 1
    await seedCheckpoint(h, checkpoint({
      id: 'checkpoint-1',
      turn: 1,
      atSeq: 1,
      prompt: 'first prompt',
      files: [],
      coverage: 'partial',
      gaps: [{ type: 'workspace', reason: 'capture-failed' }],
    }))

    const preview = await h.service.preview({ sessionId, turn: 1 })
    expect(preview.unavailable).not.toContain('first-turn')
    expect(preview.unavailable).toEqual(expect.arrayContaining([
      'incomplete-checkpoint',
      'workspace-capture-failed',
    ]))
    await expect(h.service.execute({ sessionId, turn: 1, scope: 'conversation' })).resolves.toEqual({
      sessionId,
      turn: 1,
      draft: 'first prompt',
    })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system',
    ])
  })

  it('allows restore when atSeq is 0 after session/end-seed with no system message', async () => {
    const session = makeSession()
    appendTurn(session, 1, 'lonely prompt', 'lonely answer')
    appendTurn(session, 2, 'later prompt', 'later answer')
    const h = harness({ session, seedTurns: false })
    // end-seed@0, turn/start@1 → atSeq 0
    await seedCheckpoint(h, checkpoint({
      id: 'checkpoint-1',
      turn: 1,
      atSeq: 0,
      prompt: 'lonely prompt',
      files: [],
      coverage: 'complete',
      gaps: [],
    }))

    const preview = await h.service.preview({ sessionId, turn: 1 })
    expect(preview.unavailable).not.toContain('first-turn')
    expect(preview.unavailable).not.toContain('unknown-surface')
    await expect(h.service.execute({ sessionId, turn: 1, scope: 'conversation' })).resolves.toEqual({
      sessionId,
      turn: 1,
      draft: 'lonely prompt',
    })
  })

  it('restores a completed first-turn knowledge prompt even when stored atSeq is stale', async () => {
    const prompt = '请用两句话介绍版本控制的作用，只作公开知识说明，不修改任何文件。'
    const session = makeSession()
    appendSystem(session)
    appendTurn(session, 1, prompt, '版本控制用于追踪变更并协作。')
    appendTurn(session, 2, 'follow-up', 'follow-up answer')
    const h = harness({ session, seedTurns: false })
    // Live layout: end-seed@0, system@1, turn/start@2 → real cut is end of turn 1.
    // A stale atSeq=0 used to miss the turn/start and leave confirms looking stuck.
    await seedCheckpoint(h, checkpoint({
      id: 'checkpoint-1',
      turn: 1,
      atSeq: 0,
      prompt,
      files: [],
      coverage: 'complete',
      gaps: [],
    }))

    const preview = await h.service.preview({ sessionId, turn: 1 })
    expect(preview.unavailable).toEqual([])
    expect(preview.messages.some(message => message.text === 'follow-up')).toBe(true)
    await expect(h.service.execute({ sessionId, turn: 1, scope: 'conversation' })).resolves.toEqual({
      sessionId,
      turn: 1,
      draft: prompt,
    })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system',
    ])
  })

  it('keeps the protected system prompt when Desktop appends it after turn/start', async () => {
    const prompt = '请用两句话介绍版本控制的作用，只作公开知识说明，不修改任何文件。'
    const session = makeSession()
    // Real Desktop order: turn/start first, then system prompt during step prep.
    session.append('turn/start', { turn: 1 })
    appendSystem(session)
    session.append('user/message', {
      id: MessageId('user-1'),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 0,
      message: {
        id: MessageId('assistant-1'),
        role: 'assistant',
        content: [{ type: 'text', text: '版本控制用于追踪变更并协作。' }],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    appendTurn(session, 2, 'follow-up', 'follow-up answer')
    const h = harness({ session, seedTurns: false })
    await seedCheckpoint(h, checkpoint({
      id: 'checkpoint-1',
      turn: 1,
      atSeq: 0,
      prompt,
      files: [],
      coverage: 'complete',
      gaps: [],
    }))

    const preview = await h.service.preview({ sessionId, turn: 1 })
    expect(preview.unavailable).toEqual([])
    expect(preview.messages.some(message => message.type === 'system/message')).toBe(false)
    expect(preview.messages.some(message => message.text === 'follow-up')).toBe(true)
    await expect(h.service.execute({ sessionId, turn: 1, scope: 'conversation' })).resolves.toEqual({
      sessionId,
      turn: 1,
      draft: prompt,
    })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system',
    ])
  })

  it('synthesizes a soft checkpoint for a cancelled first turn with no store entry', async () => {
    const session = makeSession()
    appendSystem(session)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', {
      id: MessageId('user-1'),
      role: 'user',
      content: [{ type: 'text', text: 'stopped mid-thought' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    appendTurn(session, 2, 'later prompt', 'later answer')
    const h = harness({ session, seedTurns: false })

    const preview = await h.service.preview({ sessionId, turn: 1 })
    expect(preview.unavailable).not.toContain('checkpoint-not-found')
    expect(preview.unavailable).not.toContain('first-turn')
    expect(preview.unavailable).not.toContain('incomplete-checkpoint')
    expect(preview.unavailable).not.toContain('workspace-capture-failed')
    expect(preview.files).toEqual([])
    expect(preview.messages.some(message => message.text === 'later prompt')).toBe(true)
    await expect(h.service.execute({ sessionId, turn: 1, scope: 'conversation' })).resolves.toEqual({
      sessionId,
      turn: 1,
      draft: 'stopped mid-thought',
    })
  })

  it('surfaces soft prompt gaps but still allows full restore of tracked files', async () => {
    const h = harness()
    await seedCheckpoint(h, checkpoint({
      coverage: 'partial',
      gaps: [{ type: 'prompt', reason: 'non-text-content' }],
      prompt: '',
    }))

    const preview = await h.service.preview({ sessionId, turn: 2 })

    expect(preview.unavailable).toEqual(expect.arrayContaining(['incomplete-checkpoint', 'prompt-non-text-content']))
    expect(preview.files).toEqual([{ path: 'file.txt', change: 'modify' }])
    await expect(h.service.execute({ sessionId, turn: 2, scope: 'conversation-and-files' }))
      .resolves.toEqual({ sessionId, turn: 2, draft: 'second prompt' })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
  })

  it('reports compaction but still allows conversation-only restore', async () => {
    const compacted = harness()
    await seedCheckpoint(compacted)
    compacted.session.append('developer/message', {
      turn: 3,
      step: 0,
      message: {
        id: MessageId('summary'),
        role: 'developer',
        content: [{ type: 'text', text: 'summary' }],
        source: { kind: 'checkpoint-rollback', form: 'notice', summary: 'Foreign compaction fixture' },
      },
    }, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(7), endSeq: SessionSeq(8) },
      sourceEventSeqs: [SessionSeq(7), SessionSeq(8)],
    })
    await expect(compacted.service.preview({ sessionId, turn: 2 }))
      .resolves.toMatchObject({ unavailable: expect.arrayContaining(['compacted-surface']) })
    await expect(compacted.service.execute({ sessionId, turn: 2, scope: 'conversation' }))
      .resolves.toEqual({ sessionId, turn: 2, draft: 'second prompt' })
  })

  it('ignores plugin version and preset drift for restore eligibility', async () => {
    const h = harness()
    await seedCheckpoint(h, checkpoint({
      pluginVersion: '0.0.1',
      session: { format: SESSION_FORMAT_VERSION, preset: 'other-preset' },
      files: [],
    }))
    const preview = await h.service.preview({ sessionId, turn: 2 })
    expect(preview.unavailable).not.toContain('incompatible-session')
    await expect(h.service.execute({ sessionId, turn: 2, scope: 'conversation' }))
      .resolves.toEqual({ sessionId, turn: 2, draft: 'second prompt' })
  })

  it('allows conversation restore without workspace permission', async () => {
    const h = harness()
    await seedCheckpoint(h, checkpoint({ files: [] }))
    h.setPermission(false)
    const preview = await h.service.preview({ sessionId, turn: 2 })
    expect(preview.unavailable).toContain('permission-denied')
    await expect(h.service.execute({ sessionId, turn: 2, scope: 'conversation' }))
      .resolves.toEqual({ sessionId, turn: 2, draft: 'second prompt' })
  })

  it('refuses subagent Sessions and unknown boundary structures', async () => {
    const child = harness({ session: makeSession('subagent') })
    await seedCheckpoint(child)
    await expect(child.service.preview({ sessionId, turn: 2 }))
      .resolves.toMatchObject({ unavailable: expect.arrayContaining(['subagent-session']) })

    const unknown = harness()
    // Checkpoint claims a turn that has no turn/start in the live log.
    await seedCheckpoint(unknown, checkpoint({ turn: 99, atSeq: 3, prompt: 'ghost' }))
    await expect(unknown.service.preview({ sessionId, turn: 99 }))
      .resolves.toMatchObject({ unavailable: expect.arrayContaining(['unknown-surface']) })
  })
})

describe('CheckpointRollbackService execute', () => {
  it('holds the Session maintenance lock through file restore and surface synchronization', async () => {
    let maintenanceDepth = 0
    const operations: CheckpointFileOperations = {
      write: async (path, text) => {
        expect(maintenanceDepth).toBe(1)
        await writeFile(path, text, 'utf8')
      },
      remove: path => rm(path, { force: true }),
    }
    const syncDepths: number[] = []
    const h = harness({
      operations,
      synchronize: async () => { syncDepths.push(maintenanceDepth) },
    })
    h.adapter.runMaintenance = async task => {
      maintenanceDepth += 1
      try {
        return await task(new AbortController().signal)
      } finally {
        maintenanceDepth -= 1
      }
    }
    await seedCheckpoint(h)

    await h.service.execute({ sessionId, turn: 2 })

    expect(maintenanceDepth).toBe(0)
    expect(syncDepths).toEqual([1, 0])
  })

  it('restores tracked files from the whole chain when jumping back multiple turns', async () => {
    const h = harness()
    const events = h.adapter.readEvents() as readonly SessionEvent[]
    const turn2Start = events.find(event => event.type === 'turn/start' && event.data.turn === 2)
    const turn3Start = events.find(event => event.type === 'turn/start' && event.data.turn === 3)
    expect(turn2Start).toBeDefined()
    expect(turn3Start).toBeDefined()
    await h.store.save(checkpoint({
      id: 'checkpoint-2',
      turn: 2,
      atSeq: Number(turn2Start!.seq),
      files: [fileCheckpoint('early.txt', 'modify', 'early-before', 'early-after')],
    }))
    await h.store.save(checkpoint({
      id: 'checkpoint-3',
      turn: 3,
      atSeq: Number(turn3Start!.seq),
      prompt: 'third prompt',
      files: [fileCheckpoint('late.txt', 'create', null, 'late-after')],
    }))
    await writeFile(join(workspaceRoot, 'early.txt'), 'early-after', 'utf8')
    await writeFile(join(workspaceRoot, 'late.txt'), 'late-after', 'utf8')

    const preview = await h.service.preview({ sessionId, turn: 2 })
    expect(preview.files).toEqual(expect.arrayContaining([
      { path: 'early.txt', change: 'modify' },
      { path: 'late.txt', change: 'create' },
    ]))

    await h.service.execute({ sessionId, turn: 2, scope: 'conversation-and-files' })

    await expect(readFile(join(workspaceRoot, 'early.txt'), 'utf8')).resolves.toBe('early-before')
    await expect(readFile(join(workspaceRoot, 'late.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores files via cut projection without appending a tip notice', async () => {
    const h = harness()
    await seedCheckpoint(h)
    const originalLength = (h.adapter.readEvents() as readonly SessionEvent[]).length

    const result = await h.service.execute({ sessionId, turn: 2 })

    expect(result).toEqual({ sessionId, turn: 2, draft: 'second prompt' })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
    const cut = await h.cuts.get(sessionId)
    expect(cut).toMatchObject({
      hideTurnsFrom: 2,
      cutSeq: 5,
      draftPrompt: 'second prompt',
      scope: 'conversation-and-files',
    })
    expect(deriveMessagesWithCut(h.session, cut).map(message => message.id)).toEqual([
      'system', 'user-1', 'assistant-1',
    ])
    const events = h.adapter.readEvents()
    expect(events).toHaveLength(originalLength)
    expect(events.some(event => (
      event.type === 'user/message' && typeof event.data.id === 'string'
      && String(event.data.id).includes('rollback:')
    ))).toBe(false)
    await expect(h.store.recoverJournal()).resolves.toEqual([])
  })

  it('still commits while maintenance flips agent status away from idle', async () => {
    const h = harness()
    await seedCheckpoint(h)
    const outer = h.adapter.runMaintenance.bind(h.adapter)
    h.adapter.runMaintenance = async task => outer(async signal => {
      h.setStatus('running')
      try {
        return await task(signal)
      } finally {
        h.setStatus('idle')
      }
    })

    await expect(h.service.execute({ sessionId, turn: 2, scope: 'conversation' })).resolves.toEqual({
      sessionId,
      turn: 2,
      draft: 'second prompt',
    })
    const cut = await h.cuts.get(sessionId)
    expect(deriveMessagesWithCut(h.session, cut).map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer',
    ])
  })

  it('does not append a surface event when a file restore step fails', async () => {
    const operations: CheckpointFileOperations = {
      write: async () => { throw new Error('injected file failure') },
      remove: path => rm(path, { force: true }),
    }
    const h = harness({ operations })
    await seedCheckpoint(h)
    const initialSeq = h.session.seq

    await expect(h.service.execute({ sessionId, turn: 2 })).rejects.toMatchObject({ code: 'ROLLBACK_FAILED' })

    expect(h.session.seq).toBe(initialSeq)
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('after')
  })

  it('does not move files when cut persistence fails before file restore', async () => {
    const h = harness()
    await seedCheckpoint(h)
    vi.spyOn(h.cuts, 'set').mockRejectedValueOnce(new Error('cut write failed'))
    const initialSeq = h.session.seq

    await expect(h.service.execute({ sessionId, turn: 2 })).rejects.toMatchObject({ code: 'ROLLBACK_FAILED' })

    expect(h.session.seq).toBe(initialSeq)
    // Cut-first: files stay at tip until the conversation cut lands.
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('after')
    await expect(h.cuts.get(sessionId)).resolves.toBeNull()
  })

  it('restores deleted files after the conversation cut commits', async () => {
    const h = harness()
    await h.store.save(checkpoint({
      files: [fileCheckpoint('gone.txt', 'delete', 'keep-me', null)],
    }))
    await expect(h.service.execute({ sessionId, turn: 2 })).resolves.toMatchObject({
      sessionId,
      turn: 2,
      draft: 'second prompt',
    })
    await expect(readFile(join(workspaceRoot, 'gone.txt'), 'utf8')).resolves.toBe('keep-me')
    await expect(h.cuts.get(sessionId)).resolves.toMatchObject({ hideTurnsFrom: 2 })
  })

  it('previews and executes an earlier cut after a successful restore', async () => {
    const h = harness()
    await seedCheckpoint(h)
    await h.service.execute({ sessionId, turn: 2 })
    await h.store.save(checkpoint({
      id: 'checkpoint-1',
      turn: 1,
      atSeq: 1,
      prompt: 'first prompt',
      createdAt: 90,
      files: [fileCheckpoint('file.txt', 'modify', 'original', 'before')],
    }))

    const preview = await h.service.preview({ sessionId, turn: 1 })
    expect(preview).toMatchObject({ unavailable: [], conflicts: [] })
    await expect(h.service.execute({ sessionId, turn: 1 })).resolves.toEqual({
      sessionId,
      turn: 1,
      draft: 'first prompt',
    })

    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('original')
    const cut = await h.cuts.get(sessionId)
    expect(cut).toMatchObject({ hideTurnsFrom: 1, cutSeq: 1 })
    expect(cut?.previous).toMatchObject({ hideTurnsFrom: 2 })
    expect(deriveMessagesWithCut(h.session, cut).map(message => message.id)).toEqual(['system'])
    await expect(h.store.recoverJournal()).resolves.toEqual([])
  })

  it('cancels an in-flight restore on close and compensates before surface append', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let writes = 0
    const operations: CheckpointFileOperations = {
      write: async (path, text) => {
        writes += 1
        if (writes === 1) await gate
        await writeFile(path, text, 'utf8')
      },
      remove: path => rm(path, { force: true }),
    }
    const h = harness({ operations })
    await seedCheckpoint(h)
    const initialSeq = h.session.seq
    const execution = h.service.execute({ sessionId, turn: 2 })
    await vi.waitFor(() => { expect(writes).toBe(1) })

    const closing = h.service.close()
    release()

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' })
    await closing
    expect(h.session.seq).toBe(initialSeq)
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('after')
  })
})

describe('CheckpointRollbackService undo', () => {
  it('clears the cut and restores after-images without appending undo shells', async () => {
    const h = harness()
    await seedCheckpoint(h)
    const originalLength = h.adapter.readEvents().length
    await h.service.execute({ sessionId, turn: 2 })

    const preview = await h.service.preview({ sessionId, turn: 2, operation: 'undo' })
    expect(preview).toMatchObject({
      operation: 'undo',
      unavailable: [],
      conflicts: [],
      messages: expect.arrayContaining([
        expect.objectContaining({ type: 'user/message', text: 'second prompt' }),
        expect.objectContaining({ type: 'assistant/message', text: 'second answer' }),
      ]),
    })
    await expect(h.service.execute({ sessionId, turn: 2, operation: 'undo' })).resolves.toEqual({
      sessionId,
      turn: 2,
      draft: '',
    })

    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('after')
    await expect(h.cuts.get(sessionId)).resolves.toBeNull()
    expect(h.adapter.readEvents()).toHaveLength(originalLength)
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'second prompt', 'second answer',
      'third prompt', 'third answer',
    ])
    await expect(h.store.recoverJournal()).resolves.toEqual([])
  })

  it('rejects undo after a file conflict but still undoes after post-restore continuation', async () => {
    const conflicted = harness()
    await seedCheckpoint(conflicted)
    await conflicted.service.execute({ sessionId, turn: 2 })
    await writeFile(join(workspaceRoot, 'file.txt'), 'new file state', 'utf8')

    await expect(conflicted.service.preview({ sessionId, turn: 2, operation: 'undo' }))
      .resolves.toMatchObject({ conflicts: [{ reason: 'hash-mismatch' }] })
    await expect(conflicted.service.execute({ sessionId, turn: 2, operation: 'undo' }))
      .rejects.toMatchObject({ code: 'ROLLBACK_CONFLICT' })

    // Fresh cut store entry for the continuation case (shared storageRoot otherwise bleeds).
    await conflicted.cuts.set(sessionId, null)
    const changed = harness()
    await seedCheckpoint(changed)
    await changed.cuts.set(sessionId, null)
    await changed.service.execute({ sessionId, turn: 2, scope: 'conversation' })
    appendTurn(changed.session, 4, 'new prompt', 'new answer')

    await expect(changed.service.preview({ sessionId, turn: 2, operation: 'undo' }))
      .resolves.toMatchObject({
        operation: 'undo',
        tipTurn: 2,
        unavailable: [],
      })
    await expect(changed.service.execute({ sessionId, turn: 2, operation: 'undo' })).resolves.toEqual({
      sessionId,
      turn: 2,
      draft: '',
    })
    await expect(changed.cuts.get(sessionId)).resolves.toBeNull()
    expect(changed.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'second prompt', 'second answer',
      'third prompt', 'third answer', 'new prompt', 'new answer',
    ])
  })

  it('undoes the live cut even when opened from a later rolled-back card', async () => {
    const h = harness()
    await seedCheckpoint(h)
    await h.store.save(checkpoint({
      id: 'checkpoint-1', turn: 1, atSeq: 1, prompt: 'first prompt', createdAt: 90, files: [],
    }))
    await h.service.execute({ sessionId, turn: 1, scope: 'conversation' })
    await expect(h.service.preview({ sessionId, turn: 2, operation: 'undo' })).resolves.toMatchObject({
      turn: 1,
      tipTurn: 1,
      operation: 'undo',
      unavailable: [],
    })
    await expect(h.service.execute({ sessionId, turn: 2, operation: 'undo' })).resolves.toEqual({
      sessionId,
      turn: 1,
      draft: '',
    })
    await expect(h.cuts.get(sessionId)).resolves.toBeNull()
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'second prompt', 'second answer',
      'third prompt', 'third answer',
    ])
  })

  it('still undoes when a protected system prompt is appended after the cut', async () => {
    const h = harness()
    await seedCheckpoint(h)
    await h.service.execute({ sessionId, turn: 2, scope: 'conversation' })
    h.session.append('system/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('system-after-tip'),
        role: 'system',
        content: [{ type: 'text', text: 'system after tip' }],
        source: { kind: 'system-prompt' },
      },
    }, { surfaceOp: 'append' })

    await expect(h.service.preview({ sessionId, turn: 2, operation: 'undo' })).resolves.toMatchObject({
      operation: 'undo',
      tipTurn: 2,
      unavailable: [],
    })
    await expect(h.service.execute({ sessionId, turn: 2, operation: 'undo' })).resolves.toEqual({
      sessionId,
      turn: 2,
      draft: '',
    })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual(expect.arrayContaining([
      'first prompt', 'first answer', 'second prompt', 'second answer', 'third prompt', 'third answer',
      'system after tip',
    ]))
  })

  it('allows full restore when checkpoint has soft gaps but no tracked files', async () => {
    const h = harness()
    await seedCheckpoint(h, checkpoint({
      files: [],
      coverage: 'partial',
      gaps: [
        { type: 'workspace', reason: 'capture-failed' },
        { type: 'prompt', reason: 'non-text-content' },
      ],
      prompt: '',
    }))
    await expect(h.service.preview({ sessionId, turn: 2 })).resolves.toMatchObject({
      files: [],
      unavailable: expect.arrayContaining([
        'incomplete-checkpoint',
        'workspace-capture-failed',
        'prompt-non-text-content',
      ]),
      conflicts: [],
    })
    await expect(h.service.execute({ sessionId, turn: 2, scope: 'conversation-and-files' }))
      .resolves.toEqual({ sessionId, turn: 2, draft: 'second prompt' })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer',
    ])
  })

  it('deletes a tracked empty create even when workspace capture was incomplete', async () => {
    const h = harness()
    await writeFile(join(workspaceRoot, 'blank.txt'), '', 'utf8')
    await seedCheckpoint(h, checkpoint({
      files: [fileCheckpoint('blank.txt', 'create', null, '')],
      coverage: 'partial',
      gaps: [{ type: 'workspace', reason: 'capture-failed' }],
    }))
    await expect(h.service.preview({ sessionId, turn: 2 })).resolves.toMatchObject({
      files: [{ path: 'blank.txt', change: 'create' }],
      unavailable: expect.arrayContaining(['incomplete-checkpoint', 'workspace-capture-failed']),
      conflicts: [],
    })
    await expect(h.service.execute({ sessionId, turn: 2, scope: 'conversation-and-files' }))
      .resolves.toEqual({ sessionId, turn: 2, draft: 'second prompt' })
    await expect(readFile(join(workspaceRoot, 'blank.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows full restore of a tracked create when only the prompt gap is soft', async () => {
    const h = harness()
    await writeFile(join(workspaceRoot, '新建文本文档.txt'), '', 'utf8')
    await seedCheckpoint(h, checkpoint({
      files: [fileCheckpoint('新建文本文档.txt', 'create', null, '')],
      coverage: 'partial',
      gaps: [{ type: 'prompt', reason: 'non-text-content' }],
      prompt: '',
    }))
    await expect(h.service.preview({ sessionId, turn: 2 })).resolves.toMatchObject({
      files: [{ path: '新建文本文档.txt', change: 'create' }],
      unavailable: expect.arrayContaining(['incomplete-checkpoint', 'prompt-non-text-content']),
      conflicts: [],
    })
    await expect(h.service.execute({ sessionId, turn: 2, scope: 'conversation-and-files' }))
      .resolves.toEqual({ sessionId, turn: 2, draft: 'second prompt' })
    await expect(readFile(join(workspaceRoot, '新建文本文档.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('supports conversation-only rollback and undo without touching tracked files', async () => {
    const h = harness()
    await seedCheckpoint(h)
    await writeFile(join(workspaceRoot, 'file.txt'), 'external edit', 'utf8')

    await expect(h.service.execute({ sessionId, turn: 2, scope: 'conversation-and-files' }))
      .rejects.toMatchObject({ code: 'ROLLBACK_CONFLICT' })
    await expect(h.service.execute({ sessionId, turn: 2, scope: 'conversation' })).resolves.toEqual({
      sessionId,
      turn: 2,
      draft: 'second prompt',
    })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('external edit')
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer',
    ])

    const undoPreview = await h.service.preview({ sessionId, turn: 2, operation: 'undo' })
    expect(undoPreview).toMatchObject({
      operation: 'undo',
      scope: 'conversation',
      unavailable: [],
    })
    // Conversation-scoped undo ignores tracked-file hash conflicts.
    await expect(h.service.execute({ sessionId, turn: 2, operation: 'undo' })).resolves.toEqual({
      sessionId,
      turn: 2,
      draft: '',
    })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('external edit')
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'second prompt', 'second answer',
      'third prompt', 'third answer',
    ])
  })

  it('supports consecutive cuts, undo of only the latest cut, and a fresh restore after undo', async () => {
    const h = harness()
    await seedCheckpoint(h)
    await h.service.execute({ sessionId, turn: 2 })
    await h.store.save(checkpoint({
      id: 'checkpoint-1', turn: 1, atSeq: 1, prompt: 'first prompt', createdAt: 90,
      files: [fileCheckpoint('file.txt', 'modify', 'original', 'before')],
    }))
    await h.service.execute({ sessionId, turn: 1 })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('original')
    expect(await h.cuts.get(sessionId)).toMatchObject({ hideTurnsFrom: 1 })

    // Undo pops previous cut (turn 2), not the full transcript.
    await expect(h.service.preview({ sessionId, turn: 2, operation: 'undo' })).resolves.toMatchObject({
      turn: 1,
      tipTurn: 1,
      operation: 'undo',
      unavailable: [],
    })
    await h.service.execute({ sessionId, turn: 2, operation: 'undo' })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
    expect(await h.cuts.get(sessionId)).toMatchObject({ hideTurnsFrom: 2 })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer',
    ])

    await h.service.execute({ sessionId, turn: 2, operation: 'undo' })
    await expect(h.cuts.get(sessionId)).resolves.toBeNull()
    await h.service.execute({ sessionId, turn: 2 })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer',
    ])
  })

  it('clears the cut on undo so later turns reappear together', async () => {
    const h = harness()
    await seedCheckpoint(h)
    await h.store.save(checkpoint({
      id: 'checkpoint-3',
      turn: 3,
      atSeq: 9,
      prompt: 'third prompt',
      files: [],
      createdAt: 110,
    }))
    await h.service.execute({ sessionId, turn: 2, scope: 'conversation' })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer',
    ])

    await expect(h.service.execute({ sessionId, turn: 2, operation: 'undo' })).resolves.toEqual({
      sessionId,
      turn: 2,
      draft: '',
    })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'second prompt', 'second answer',
      'third prompt', 'third answer',
    ])
    const summaries = await h.service.summaries({ sessionId })
    expect(summaries.turns.every(turn => turn.tip === false)).toBe(true)
  })

  it('re-restoring an earlier cut withdraws later turns again without tip shells', async () => {
    const session = makeSession()
    appendSystem(session)
    appendTurn(session, 1, 'first prompt', 'first answer')
    appendTurn(session, 2, 'second prompt', 'second answer')
    appendTurn(session, 3, 'third prompt', 'third answer')
    appendTurn(session, 4, 'fourth prompt', 'fourth answer')
    const h = harness({ session, seedTurns: false })
    const turn3Start = session.snapshotEvents().find(event => (
      event.type === 'turn/start' && event.data.turn === 3
    ))
    expect(turn3Start).toBeDefined()
    await seedCheckpoint(h, checkpoint({
      turn: 3,
      atSeq: Number(turn3Start!.seq) - 1,
      prompt: 'third prompt',
      files: [],
    }))
    await h.store.save(checkpoint({
      id: 'checkpoint-4',
      turn: 4,
      atSeq: Number(session.snapshotEvents().find(event => (
        event.type === 'turn/start' && event.data.turn === 4
      ))!.seq) - 1,
      prompt: 'fourth prompt',
      files: [],
      createdAt: 120,
    }))

    await h.service.execute({ sessionId, turn: 3, scope: 'conversation' })
    await h.service.execute({ sessionId, turn: 3, operation: 'undo' })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'second prompt', 'second answer',
      'third prompt', 'third answer', 'fourth prompt', 'fourth answer',
    ])

    await h.service.execute({ sessionId, turn: 3, scope: 'conversation' })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'second prompt', 'second answer',
    ])
    await h.service.execute({ sessionId, turn: 3, operation: 'undo' })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'second prompt', 'second answer',
      'third prompt', 'third answer', 'fourth prompt', 'fourth answer',
    ])
  })

  it('treats re-restoring the active cut as already-restored without rewriting the log', async () => {
    const h = harness()
    await seedCheckpoint(h)
    await h.service.execute({ sessionId, turn: 2, scope: 'conversation' })
    const afterFirst = h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    expect(afterFirst).toEqual([
      'system', 'first prompt', 'first answer',
    ])
    const tipSeq = h.adapter.readEvents().at(-1)!.seq

    await expect(h.service.preview({ sessionId, turn: 2 })).resolves.toMatchObject({
      messages: [],
      unavailable: expect.arrayContaining(['already-restored']),
    })
    await expect(h.service.execute({ sessionId, turn: 2, scope: 'conversation' })).resolves.toEqual({
      sessionId,
      turn: 2,
      draft: 'second prompt',
    })
    expect(h.adapter.readEvents().at(-1)!.seq).toBe(tipSeq)
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual(afterFirst)
  })

  it('keeps original tool-call events in the log and restores them by clearing the cut', async () => {
    const session = makeSession()
    appendSystem(session)
    appendTurn(session, 1, 'first prompt', 'first answer')
    appendTurnWithTool(session, 2, 'use the tool', 'call-undo-1', 'tool output', 'second answer')
    const turn2Start = session.snapshotEvents().find(event => (
      event.type === 'turn/start' && event.data.turn === 2
    ))
    expect(turn2Start).toBeDefined()
    const h = harness({ session, seedTurns: false })
    await seedCheckpoint(h, checkpoint({
      turn: 2,
      atSeq: Number(turn2Start!.seq) - 1,
      prompt: 'use the tool',
      files: [],
    }))
    const originalLength = h.adapter.readEvents().length
    await h.service.execute({ sessionId, turn: 2, scope: 'conversation' })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer',
    ])
    await h.service.execute({ sessionId, turn: 2, operation: 'undo' })

    expect(h.adapter.readEvents()).toHaveLength(originalLength)
    expect(h.adapter.readEvents().some(event => (
      event.type === 'tool/call' && event.data.callId === ToolCallId('call-undo-1')
    ))).toBe(true)
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'use the tool', '', 'tool output', 'second answer',
    ])
  })

  it('does not resume tip-append undo shells during journal recovery', async () => {
    const h = harness({ createId: () => 'restore-1' })
    await seedCheckpoint(h)
    await h.service.execute({ sessionId, turn: 2 })
    // Cut path has no tip append — recovery completes when the cut journal id matches.
    await expect(h.cuts.get(sessionId)).resolves.toMatchObject({ hideTurnsFrom: 2 })
    await h.service.recover()
    await expect(h.store.recoverJournal()).resolves.toEqual([])
  })

})

describe('CheckpointRollbackService journal recovery', () => {
  it('blocks previews without performing recovery side effects while a journal is pending', async () => {
    const store = new CheckpointStore(storageRoot)
    await store.beginJournal({
      schemaVersion: 1,
      id: 'restore-1',
      sessionId,
      checkpointId: 'checkpoint-2',
      status: 'files-restored',
      createdAt: 1,
    })
    const h = harness()
    await seedCheckpoint(h)

    await expect(h.service.preview({ sessionId, turn: 2 })).rejects.toMatchObject({ code: 'ROLLBACK_RECOVERY_FAILED' })
    await expect(h.service.preview({ sessionId: SessionId('other-session'), turn: 2 }))
      .rejects.toMatchObject({ code: 'ROLLBACK_RECOVERY_FAILED' })

    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('after')
    await expect(store.recoverJournal()).resolves.toMatchObject([{ id: 'restore-1', status: 'files-restored' }])
  })

  it('keeps restored files when cut wrote but projection sync failed', async () => {
    const h = harness({
      createId: () => 'restore-1',
      synchronize: async () => { throw new Error('projection reported as a failure') },
    })
    await seedCheckpoint(h)

    await expect(h.service.execute({ sessionId, turn: 2 })).resolves.toMatchObject({
      sessionId,
      turn: 2,
    })

    expect(await h.cuts.get(sessionId)).toMatchObject({ hideTurnsFrom: 2, journalId: 'restore-1' })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
    await expect(h.store.recoverJournal()).resolves.toEqual([])
  })

  it('does not leave a pending journal when only post-cut projection sync fails', async () => {
    let synchronizations = 0
    const h = harness({
      createId: () => 'restore-1',
      synchronize: async () => {
        synchronizations += 1
        throw new Error('first projection attempt fails')
      },
    })
    await seedCheckpoint(h)
    await expect(h.service.execute({ sessionId, turn: 2 })).resolves.toMatchObject({ turn: 2 })

    // execute retries synchronize once outside maintenance; both attempts may throw.
    expect(synchronizations).toBeGreaterThanOrEqual(1)
    await expect(h.store.recoverJournal()).resolves.toEqual([])
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
  })

  it('completes restore without a pending journal when projection is unavailable after the cut', async () => {
    const h = harness({
      createId: () => 'restore-1',
      synchronize: async () => { throw new Error('projection unavailable after append') },
    })
    await seedCheckpoint(h)

    await expect(h.service.execute({ sessionId, turn: 2 })).resolves.toMatchObject({ turn: 2 })
    await expect(h.store.recoverJournal()).resolves.toEqual([])
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
    expect(await h.cuts.get(sessionId)).toMatchObject({ hideTurnsFrom: 2, journalId: 'restore-1' })
  })

  it('compensates a crash-pending journal when its surface append is absent', async () => {
    const store = new CheckpointStore(storageRoot)
    await writeFile(join(workspaceRoot, 'file.txt'), 'after', 'utf8')
    const files = new CheckpointFiles({
      workspaceRoot,
      storageRoot,
      store,
      sessionId,
      checkpointId: 'checkpoint-2',
      createId: () => 'restore-1',
    })
    // Uncertain surface outcome leaves files restored and a pending journal.
    await expect(files.runTransaction(
      [fileCheckpoint('file.txt', 'modify', 'before', 'after')],
      async () => { throw new Error('projection outcome is unknown') },
    )).rejects.toMatchObject({ code: 'FILE_RESTORE_FAILED' })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
    const interruptedWrite = join(storageRoot, 'checkpoints', `.${digest(sessionId)}.json.orphan.tmp`)
    await mkdir(join(storageRoot, 'checkpoints'), { recursive: true })
    await writeFile(interruptedWrite, '{}', 'utf8')

    const h = harness()
    await h.service.recover()

    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('after')
    await expect(readFile(interruptedWrite, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(store.recoverJournal()).resolves.toEqual([])
  })
})

describe('CheckpointRollbackService summaries', () => {
  it('returns lightweight per-turn coverage without file bodies', async () => {
    const h = harness()
    await seedCheckpoint(h)
    await h.store.save(checkpoint({
      id: 'checkpoint-3',
      turn: 3,
      atSeq: 9,
      coverage: 'partial',
      gaps: [{ type: 'workspace', reason: 'capture-failed' }],
      files: [],
      prompt: '',
    }))

    const summaries = await h.service.summaries({ sessionId })
    expect(summaries.activity).toMatchObject({
      turns: 3,
      steps: 3,
      checkpoints: 3,
      liveCheckpoints: 3,
    })
    expect(summaries.turns.map(turn => turn.turn)).toEqual([1, 2, 3])
    expect(summaries.turns.find(turn => turn.turn === 1)).toMatchObject({
      prompt: 'first prompt',
      coverage: 'complete',
      fileCount: 0,
    })
    expect(summaries.turns.find(turn => turn.turn === 2)).toMatchObject({
      coverage: 'complete',
      fileCount: 1,
      prompt: 'second prompt',
      files: [{ path: 'file.txt', change: 'modify' }],
    })
    expect(summaries.turns.find(turn => turn.turn === 3)).toMatchObject({
      coverage: 'partial',
      // Soft store entry; live events still recover the seeded turn-3 prompt.
      prompt: 'third prompt',
      gaps: [{ type: 'workspace', reason: 'capture-failed' }],
    })
  })

  it('marks the live cut tip and reports surface-scoped activity after restore', async () => {
    const h = harness()
    await seedCheckpoint(h)
    await h.store.save(checkpoint({
      id: 'checkpoint-1',
      turn: 1,
      atSeq: 1,
      prompt: 'first prompt',
      files: [],
    }))
    await h.service.execute({ sessionId, turn: 2, scope: 'conversation' })

    const summaries = await h.service.summaries({ sessionId })
    expect(summaries.turns.find(turn => turn.tip)?.turn).toBe(2)
    expect(summaries.turns.find(turn => turn.turn === 2)).toMatchObject({ rolledBack: true, tip: true })
    expect(summaries.turns.find(turn => turn.turn === 3)).toMatchObject({ rolledBack: true, tip: false })
    expect(summaries.activity.checkpoints).toBe(summaries.turns.length)
    expect(summaries.activity.liveCheckpoints).toBe(summaries.turns.filter(turn => !turn.rolledBack).length)
    expect(summaries.activity.turns).toBeGreaterThan(0)
    expect(summaries.activity.steps).toBeGreaterThan(0)
  })

  it('returns an empty list when rollback is disabled', async () => {
    const h = harness()
    await seedCheckpoint(h)
    h.setEnabled(false)
    await expect(h.service.summaries({ sessionId })).resolves.toEqual({
      sessionId,
      activity: { turns: 0, steps: 0, checkpoints: 0, liveCheckpoints: 0 },
      turns: [],
    })
  })

  it('backfills conversation checkpoints for closed turns missing from the store', async () => {
    const session = makeSession()
    appendSystem(session)
    appendTurn(session, 1, 'first prompt', 'first answer')
    appendTurn(session, 2, 'second prompt', 'second answer')
    const h = harness({ session, seedTurns: false })
    // No store rows — live capture missed both turns.
    const summaries = await h.service.summaries({ sessionId })
    expect(summaries.turns.map(turn => turn.turn)).toEqual([1, 2])
    expect(summaries.turns.map(turn => turn.prompt)).toEqual(['first prompt', 'second prompt'])
    expect(summaries.activity.checkpoints).toBe(2)
    // Persisted for the next open.
    await expect(h.store.list(sessionId)).resolves.toHaveLength(2)
  })
})

describe('checkpoint rollback Host Remote', () => {
  it('publishes an independent strict namespace without client-controlled paths or boundaries', () => {
    expect(checkpointRemoteInfo.descriptors).toHaveLength(4)
    expect(checkpointRemoteInfo.descriptors).toEqual(expect.arrayContaining([
      expect.objectContaining({ namespace: 'checkpointRollback', method: 'preview', service: 'checkpointRollback' }),
      expect.objectContaining({ namespace: 'checkpointRollback', method: 'execute', service: 'checkpointRollback' }),
      expect.objectContaining({ namespace: 'checkpointRollback', method: 'summaries', service: 'checkpointRollback' }),
      expect.objectContaining({ namespace: 'checkpointRollback', method: 'getCut', service: 'checkpointRollback' }),
    ]))
    expect(checkpointHostContribution.invocations).toEqual(checkpointRemoteInfo.descriptors)
    expect(checkpointRollbackRequestSchema.parse({ sessionId, turn: 2 })).toEqual({ sessionId, turn: 2 })
    expect(checkpointRollbackRequestSchema.parse({ sessionId, turn: 2, operation: 'undo' }))
      .toEqual({ sessionId, turn: 2, operation: 'undo' })
    // Timeline pins tips with atSeq; rejecting it made every "恢复到这里" open fail as figure-1.
    expect(checkpointRollbackRequestSchema.parse({ sessionId, turn: 2, atSeq: 5 }))
      .toEqual({ sessionId, turn: 2, atSeq: 5 })
    expect(() => checkpointRollbackRequestSchema.parse({ sessionId, turn: 2, operation: 'replace' })).toThrow()
    expect(() => checkpointRollbackRequestSchema.parse({ sessionId, turn: 2, path: 'file.txt' })).toThrow()
    expect(() => checkpointRollbackRequestSchema.parse({ sessionId, turn: 2, workspaceRoot: root })).toThrow()
  })

  it('allows owner preview and rejects guests before reading checkpoint state', async () => {
    const h = harness()
    await seedCheckpoint(h)
    const ownerCtx = new Context()
    const guestCtx = new Context()
    contexts.push(ownerCtx, guestCtx)
    ownerCtx.provide('invocation', { peer: { principal: { kind: 'owner' } } } as never)
    guestCtx.provide('invocation', { peer: { principal: { kind: 'guest' } } } as never)
    const owner = new CheckpointRollbackRemoteService(ownerCtx, h.service)
    const guest = new CheckpointRollbackRemoteService(guestCtx, h.service)
    const signal = new AbortController().signal

    await expect(owner.preview({ sessionId, turn: 2 }, signal)).resolves.toMatchObject({
      sessionId,
      turn: 2,
      unavailable: [],
    })
    await expect(guest.preview({ sessionId, turn: 2 }, signal)).rejects.toMatchObject({
      code: 'agent-enhancer/forbidden',
    })
  })

  it('maps execution failures to stable safe Remote categories', async () => {
    const h = harness()
    await seedCheckpoint(h)
    await writeFile(join(workspaceRoot, 'file.txt'), 'private concurrent contents', 'utf8')
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('invocation', { peer: { principal: { kind: 'owner' } } } as never)
    const remote = new CheckpointRollbackRemoteService(ctx, h.service)

    const rejection = await remote.execute({ sessionId, turn: 2 }, new AbortController().signal)
      .catch((error: unknown) => error)

    expect(rejection).toMatchObject({
      code: 'agent-enhancer/rollback-failed',
      message: 'Checkpoint rollback request failed',
      details: { code: 'ROLLBACK_CONFLICT' },
    })
    expect((rejection as Error).message).not.toContain('private concurrent contents')
  })

  it('exposes the rollback Remote service without a second package-face typert register', async () => {
    const h = harness()
    const ctx = new Context()
    contexts.push(ctx)
    const register = vi.fn(() => () => {})
    ctx.provide('typert', { register } as never)

    applyCheckpointRollback(ctx, h.service)

    expect(register).not.toHaveBeenCalled()
    expect(ctx.checkpointRollback).toBeInstanceOf(CheckpointRollbackRemoteService)
    expect(checkpointHostContribution.invocations).toEqual(checkpointRemoteInfo.descriptors)
    await ctx.fiber.dispose()
  })
})
