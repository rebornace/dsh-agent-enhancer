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
import { isUndoShellCheckpoint, undoShellRanges } from '../src/host/checkpoint/activity.ts'
import { CheckpointFiles } from '../src/host/checkpoint/files.ts'
import type { CheckpointFileOperations } from '../src/host/checkpoint/files.ts'
import { CheckpointRollbackService } from '../src/host/checkpoint/service.ts'
import type {
  CheckpointRollbackServiceOptions,
  CheckpointServiceSession,
} from '../src/host/checkpoint/service.ts'
import { CheckpointStore } from '../src/host/checkpoint/store.ts'
import type { Checkpoint, FileCheckpoint } from '../src/host/checkpoint/types.ts'
import { isUndoId } from '../src/identity.ts'

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
  const serviceOptions: CheckpointRollbackServiceOptions = {
    store,
    storageRoot,
    pluginVersion: '0.2.0',
    resolveSession: id => id === current.session.id ? current : undefined,
    isEnabled: () => enabled,
    operations: options.operations,
    createId: options.createId,
  }
  const service = new CheckpointRollbackService(serviceOptions)
  services.push(service)
  return {
    service,
    store,
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
      'system', expect.stringContaining('before turn 1'),
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
      expect.stringContaining('before turn 1'),
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
      expect.stringContaining('before turn 1'),
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

  it('restores files and model-visible surface and returns only the plain-text draft', async () => {
    const h = harness()
    await seedCheckpoint(h)
    const originalLength = (h.adapter.readEvents() as readonly SessionEvent[]).length

    const result = await h.service.execute({ sessionId, turn: 2 })

    expect(result).toEqual({ sessionId, turn: 2, draft: 'second prompt' })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
    expect(h.session.deriveMessages().map(message => message.id)).toEqual([
      'system', 'user-1', 'assistant-1',
      expect.stringMatching(/^dsh-agent-enhancer:rollback:2:/),
    ])
    const events = h.adapter.readEvents()
    expect(events).toHaveLength(originalLength + 1)
    expect(events.at(-1)).toMatchObject({
      type: 'user/message',
      surfaceOp: { op: 'replace', startSeq: 7, endSeq: 12 },
      sourceEventSeqs: [7, 8, 11, 12],
      data: {
        role: 'user',
        source: { kind: 'checkpoint-rollback', form: 'notice' },
        content: [{ type: 'text', text: expect.stringContaining('before turn 2') }],
      },
    })
    expect(events.filter(event => event.type === 'user/message')).toHaveLength(4)
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
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer',
      expect.stringContaining('before turn 2'),
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

  it('compensates files only when Session append explicitly did not happen', async () => {
    const h = harness()
    await seedCheckpoint(h)
    vi.spyOn(h.session, 'append').mockImplementation(() => { throw new Error('append rejected before commit') })
    const initialSeq = h.session.seq

    await expect(h.service.execute({ sessionId, turn: 2 })).rejects.toMatchObject({ code: 'ROLLBACK_FAILED' })

    expect(h.session.seq).toBe(initialSeq)
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('after')
    await expect(h.store.recoverJournal()).resolves.toEqual([])
  })

  it('rejects a Session identity change after file restore and compensates without appending', async () => {
    let writes = 0
    let h!: Harness
    const operations: CheckpointFileOperations = {
      write: async (path, text) => {
        writes += 1
        if (writes === 1) {
          const replacement = makeSession()
          h.setCurrent({
            ...h.adapter,
            session: replacement,
            readEvents: () => replacement.snapshotEvents(),
          })
        }
        await writeFile(path, text, 'utf8')
      },
      remove: path => rm(path, { force: true }),
    }
    h = harness({ operations })
    await seedCheckpoint(h)
    const originalSession = h.session

    await expect(h.service.execute({ sessionId, turn: 2 })).rejects.toMatchObject({ code: 'ROLLBACK_FAILED' })

    expect(originalSession.surface.nodes).toEqual([1, 3, 4, 7, 8, 11, 12])
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('after')
  })

  it('previews and executes an earlier rollback after a successful rollback marker', async () => {
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
    expect(h.session.deriveMessages().map(message => message.id)).toEqual([
      'system', expect.stringMatching(/^dsh-agent-enhancer:rollback:1:/),
    ])
    expect(h.adapter.readEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'checkpoint-rollback')).toHaveLength(2)
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
  it('previews and restores the pre-rollback surface and after-images without deleting log events', async () => {
    const h = harness()
    await seedCheckpoint(h)
    const originalLength = h.adapter.readEvents().length
    await h.service.execute({ sessionId, turn: 2 })

    // Peel tip 2 only — turn 3 stays withdrawn under a new tip.
    const preview = await h.service.preview({ sessionId, turn: 2, operation: 'undo' })
    expect(preview).toMatchObject({
      operation: 'undo',
      unavailable: [],
      conflicts: [],
      messages: [
        { seq: 7, type: 'user/message', text: 'second prompt' },
        { seq: 8, type: 'assistant/message', text: 'second answer' },
      ],
    })
    await expect(h.service.execute({ sessionId, turn: 2, operation: 'undo' })).resolves.toEqual({
      sessionId,
      turn: 2,
      draft: '',
    })

    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('after')
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'second prompt', 'second answer',
      expect.stringContaining('before turn 3'),
    ])
    // restore marker + undo shell (turn/start+step/start+user+assistant+step/end+turn/end) + next tip
    expect(h.adapter.readEvents()).toHaveLength(originalLength + 8)
    // original 3 user msgs + restore notice + undo user copy + next-tip notice
    expect(h.adapter.readEvents().filter(event => event.type === 'user/message')).toHaveLength(6)
    await expect(h.store.recoverJournal()).resolves.toEqual([])
  })

  it('rejects undo after a file conflict but still undoes when the user continued after the tip', async () => {
    const conflicted = harness()
    await seedCheckpoint(conflicted)
    await conflicted.service.execute({ sessionId, turn: 2 })
    await writeFile(join(workspaceRoot, 'file.txt'), 'new file state', 'utf8')

    await expect(conflicted.service.preview({ sessionId, turn: 2, operation: 'undo' }))
      .resolves.toMatchObject({ conflicts: [{ reason: 'hash-mismatch' }] })
    await expect(conflicted.service.execute({ sessionId, turn: 2, operation: 'undo' }))
      .rejects.toMatchObject({ code: 'ROLLBACK_CONFLICT' })

    // Post-restore chat must not trap undo as session-changed — peel tip 2 even
    // after the user continued past the tip marker.
    const changed = harness()
    await seedCheckpoint(changed)
    await changed.service.execute({ sessionId, turn: 2, scope: 'conversation' })
    appendTurn(changed.session, 4, 'new prompt', 'new answer')

    await expect(changed.service.preview({ sessionId, turn: 2, operation: 'undo' }))
      .resolves.toMatchObject({
        operation: 'undo',
        tipTurn: 2,
        unavailable: [],
        messages: [
          { type: 'user/message', text: 'second prompt' },
          { type: 'assistant/message', text: 'second answer' },
        ],
      })
    await expect(changed.service.execute({ sessionId, turn: 2, operation: 'undo' })).resolves.toEqual({
      sessionId,
      turn: 2,
      draft: '',
    })
    expect(changed.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'second prompt', 'second answer',
      expect.stringContaining('before turn 3'),
    ])
  })

  it('undoes the live tip even when keep-prefix projection looks newer than the cut', async () => {
    const h = harness()
    await seedCheckpoint(h)
    await h.store.save(checkpoint({
      id: 'checkpoint-1', turn: 1, atSeq: 1, prompt: 'first prompt', createdAt: 90, files: [],
    }))
    await h.service.execute({ sessionId, turn: 1, scope: 'conversation' })
    // Covered card open — must remap to tip 1 and not die on session-changed.
    // Before-1 withdraws turns 1+2+3; undo peels only turn 1, tip moves to 2.
    await expect(h.service.preview({ sessionId, turn: 2, operation: 'undo' })).resolves.toMatchObject({
      turn: 1,
      tipTurn: 1,
      operation: 'undo',
      unavailable: [],
      messages: [
        { type: 'user/message', text: 'first prompt' },
        { type: 'assistant/message', text: 'first answer' },
      ],
    })
    // execute keeps the request turn; preview already remapped the tip for the client.
    await expect(h.service.execute({ sessionId, turn: 2, operation: 'undo' })).resolves.toEqual({
      sessionId,
      turn: 2,
      draft: '',
    })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer',
      expect.stringContaining('before turn 2'),
    ])
  })

  it('still undoes when a protected system prompt sits after the restore marker', async () => {
    const h = harness()
    await seedCheckpoint(h)
    await h.service.execute({ sessionId, turn: 2, scope: 'conversation' })
    // Desktop may re-place the system prompt after the tip; undo must still find the marker.
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
      messages: [
        { type: 'user/message', text: 'second prompt' },
        { type: 'assistant/message', text: 'second answer' },
      ],
    })
    await expect(h.service.execute({ sessionId, turn: 2, operation: 'undo' })).resolves.toEqual({
      sessionId,
      turn: 2,
      draft: '',
    })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual(expect.arrayContaining([
      'first prompt', 'first answer', 'second prompt', 'second answer',
      expect.stringMatching(/before turn 3/),
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
      expect.stringContaining('before turn 2'),
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
      expect.stringContaining('before turn 2'),
    ])

    const undoPreview = await h.service.preview({ sessionId, turn: 2, operation: 'undo' })
    expect(undoPreview).toMatchObject({
      operation: 'undo',
      scope: 'conversation',
      conflicts: [{ reason: 'hash-mismatch' }],
      unavailable: [],
    })
    await expect(h.service.execute({ sessionId, turn: 2, operation: 'undo' })).resolves.toEqual({
      sessionId,
      turn: 2,
      draft: '',
    })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('external edit')
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'second prompt', 'second answer',
      expect.stringContaining('before turn 3'),
    ])
  })

  it('supports consecutive rollbacks, undo of only the latest rollback, and a fresh rollback after undo', async () => {
    const h = harness()
    await seedCheckpoint(h)
    await h.service.execute({ sessionId, turn: 2 })
    await h.store.save(checkpoint({
      id: 'checkpoint-1', turn: 1, atSeq: 1, prompt: 'first prompt', createdAt: 90,
      files: [fileCheckpoint('file.txt', 'modify', 'original', 'before')],
    }))
    await h.service.execute({ sessionId, turn: 1 })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('original')

    // Asking to undo a later rolled-back card still undoes the live tip (turn 1).
    await expect(h.service.preview({ sessionId, turn: 2, operation: 'undo' })).resolves.toMatchObject({
      turn: 1,
      tipTurn: 1,
      operation: 'undo',
      unavailable: [],
    })
    await h.service.execute({ sessionId, turn: 2, operation: 'undo' })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer',
      expect.stringContaining('before turn 2'),
    ])

    // After undoing tip turn 1, tip peels to turn 2 — undo that next (peels turn 2, tip→3).
    await expect(h.service.preview({ sessionId, turn: 2, operation: 'undo' })).resolves.toMatchObject({
      turn: 2,
      tipTurn: 2,
      unavailable: [],
    })
    await h.service.execute({ sessionId, turn: 2, operation: 'undo' })
    await h.service.execute({ sessionId, turn: 2 })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer',
      expect.stringContaining('before turn 2'),
    ])
  })

  it('peels one tip turn on undo so turn 3 stays rolled back after undoing tip 2', async () => {
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
    // Restore before turn 2 → withdraws turns 2 and 3.
    await h.service.execute({ sessionId, turn: 2, scope: 'conversation' })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer',
      expect.stringContaining('before turn 2'),
    ])

    // Undo tip 2 → only turn 2 returns; tip moves to turn 3.
    const undoPreview = await h.service.preview({ sessionId, turn: 2, operation: 'undo' })
    expect(undoPreview.messages.map(message => message.text)).toEqual([
      'second prompt', 'second answer',
    ])
    expect(undoPreview.messages.some(message => message.text === 'third prompt')).toBe(false)
    await expect(h.service.execute({ sessionId, turn: 2, operation: 'undo' })).resolves.toEqual({
      sessionId,
      turn: 2,
      draft: '',
    })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'second prompt', 'second answer',
      expect.stringContaining('before turn 3'),
    ])
    const summaries = await h.service.summaries({ sessionId })
    expect(summaries.turns.find(turn => turn.tip === true)?.turn).toBe(3)
    expect(summaries.turns.find(turn => turn.turn === 2)).toMatchObject({ rolledBack: false, tip: false })
  })

  it('peels by logical turn after undo shell so re-restoring tip 3 does not revive turn 4', async () => {
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

    // Restore before 3 → withdraw 3+4; peel undo tip 3 → only 3 returns, tip→4.
    await h.service.execute({ sessionId, turn: 3, scope: 'conversation' })
    await h.service.execute({ sessionId, turn: 3, operation: 'undo' })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'second prompt', 'second answer',
      'third prompt', 'third answer',
      expect.stringContaining('before turn 4'),
    ])

    // Re-restore before the same turn-3 card. Undo copies sit under a newer shell
    // turn id than original turn 4 — peel must still leave turn 4 withdrawn.
    await h.service.execute({ sessionId, turn: 3, scope: 'conversation' })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'second prompt', 'second answer',
      expect.stringContaining('before turn 3'),
    ])
    const undoPreview = await h.service.preview({ sessionId, turn: 3, operation: 'undo' })
    expect(undoPreview.messages.map(message => message.text)).toEqual([
      'third prompt', 'third answer',
    ])
    expect(undoPreview.messages.some(message => message.text === 'fourth prompt')).toBe(false)
    await h.service.execute({ sessionId, turn: 3, operation: 'undo' })
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'second prompt', 'second answer',
      'third prompt', 'third answer',
      expect.stringContaining('before turn 4'),
    ])
    const summaries = await h.service.summaries({ sessionId })
    expect(summaries.turns.find(turn => turn.tip === true)?.turn).toBe(4)
  })

  it('treats re-restoring the active tip as already-restored and skips a no-op surface append', async () => {
    const h = harness()
    await seedCheckpoint(h)
    await h.service.execute({ sessionId, turn: 2, scope: 'conversation' })
    const afterFirst = h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    expect(afterFirst).toEqual([
      'system', 'first prompt', 'first answer',
      expect.stringContaining('before turn 2'),
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

  it('restores tool calls with synthetic tool/call rows so the log reloads', async () => {
    const session = makeSession()
    appendSystem(session)
    appendTurn(session, 1, 'first prompt', 'first answer')
    appendTurnWithTool(session, 2, 'use the tool', 'call-undo-1', 'tool output', 'second answer')
    const turn2Start = session.snapshotEvents().find(event => (
      event.type === 'turn/start' && event.data.turn === 2
    ))
    expect(turn2Start).toBeDefined()
    const h = harness({ session, seedTurns: false })
    // Restore-before-2 withdraws the tool turn; undo rematerializes tool/call rows.
    await seedCheckpoint(h, checkpoint({
      turn: 2,
      atSeq: Number(turn2Start!.seq) - 1,
      prompt: 'use the tool',
      files: [],
    }))
    await h.service.execute({ sessionId, turn: 2, scope: 'conversation' })
    await h.service.execute({ sessionId, turn: 2, operation: 'undo' })

    const events = h.adapter.readEvents()
    const undoAssistant = events.find(event => (
      event.type === 'assistant/message'
      && event.data.message.id.startsWith('dsh-agent-enhancer:undo:')
      && event.data.message.content.some(block => block.type === 'tool-call')
    ))
    expect(undoAssistant?.type).toBe('assistant/message')
    const undoStart = Number(undoAssistant!.seq)
    const undoToolCall = events.find(event => (
      event.type === 'tool/call'
      && Number(event.seq) > undoStart
      && event.data.callId === ToolCallId('call-undo-1')
    ))
    const undoToolResult = events.find(event => (
      event.type === 'tool/result'
      && Number(event.seq) > undoStart
      && event.data.message.toolCallId === ToolCallId('call-undo-1')
      && event.data.message.id.startsWith('dsh-agent-enhancer:undo:')
    ))
    expect(undoToolCall).toBeDefined()
    expect(undoToolResult).toBeDefined()
    expect(Number(undoToolCall!.seq)).toBeLessThan(Number(undoToolResult!.seq))
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'use the tool', '', 'tool output', 'second answer',
    ])
  })

  it('resumes a partially appended undo during journal recovery', async () => {
    const h = harness({ createId: () => 'restore-1' })
    await seedCheckpoint(h)
    await h.service.execute({ sessionId, turn: 2 })
    const append = h.session.append.bind(h.session)
    let appends = 0
    vi.spyOn(h.session, 'append').mockImplementation(((...args: unknown[]) => {
      appends += 1
      const event = Reflect.apply(append, h.session, args) as SessionEvent
      // Fail after turn/start + step/start + first undo copy are persisted.
      if (appends === 3) throw new Error('append persisted before the failure')
      return event
    }) as Session['append'])

    await expect(h.service.execute({ sessionId, turn: 2, operation: 'undo' }))
      .rejects.toMatchObject({ code: 'ROLLBACK_FAILED' })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('after')
    await expect(h.store.recoverJournal()).resolves.toMatchObject([{ status: 'files-restored' }])

    vi.restoreAllMocks()
    await h.service.recover()

    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', 'second prompt', 'second answer',
      expect.stringContaining('before turn 3'),
    ])
    await expect(h.store.recoverJournal()).resolves.toEqual([])
  })
})

describe('CheckpointRollbackService journal recovery', () => {
  it('blocks previews without performing recovery side effects while a journal is pending', async () => {
    let synchronizations = 0
    const h = harness({
      createId: () => 'restore-1',
      synchronize: async () => {
        synchronizations += 1
        throw new Error('projection remains unavailable')
      },
    })
    await seedCheckpoint(h)
    await expect(h.service.execute({ sessionId, turn: 2 })).rejects.toMatchObject({ code: 'ROLLBACK_FAILED' })
    expect(synchronizations).toBe(1)

    await expect(h.service.preview({ sessionId, turn: 2 })).rejects.toMatchObject({ code: 'ROLLBACK_RECOVERY_FAILED' })
    await expect(h.service.preview({ sessionId: SessionId('other-session'), turn: 2 }))
      .rejects.toMatchObject({ code: 'ROLLBACK_RECOVERY_FAILED' })

    expect(synchronizations).toBe(1)
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
    await expect(h.store.recoverJournal()).resolves.toMatchObject([{ id: 'restore-1', status: 'files-restored' }])
  })

  it('detects an append that persisted before throwing and leaves files for recovery', async () => {
    const h = harness({ createId: () => 'restore-1' })
    await seedCheckpoint(h)
    const append = h.session.append.bind(h.session)
    vi.spyOn(h.session, 'append').mockImplementation(((...args: unknown[]) => {
      Reflect.apply(append, h.session, args)
      throw new Error('append outcome was reported as a failure')
    }) as Session['append'])

    await expect(h.service.execute({ sessionId, turn: 2 })).rejects.toMatchObject({ code: 'ROLLBACK_FAILED' })

    // Keep-prefix (system + turn 1) + restore notice after withdrawing turns 2–3.
    expect(h.session.surface.nodes).toHaveLength(4)
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
    await expect(h.store.recoverJournal()).resolves.toMatchObject([{ status: 'files-restored' }])
    vi.restoreAllMocks()
    await h.service.recover()
    await expect(h.store.recoverJournal()).resolves.toEqual([])
  })

  it('retries synchronization on the same instance before completing an appended journal', async () => {
    let synchronizations = 0
    const h = harness({
      createId: () => 'restore-1',
      synchronize: async () => {
        synchronizations += 1
        if (synchronizations === 1) throw new Error('first projection attempt fails')
      },
    })
    await seedCheckpoint(h)
    await expect(h.service.execute({ sessionId, turn: 2 })).rejects.toMatchObject({ code: 'ROLLBACK_FAILED' })

    await h.service.recover()

    expect(synchronizations).toBe(2)
    await expect(h.store.recoverJournal()).resolves.toEqual([])
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
  })

  it('completes a crash-pending journal when its surface append is present', async () => {
    const h = harness({
      createId: () => 'restore-1',
      synchronize: async () => { throw new Error('projection unavailable after append') },
    })
    await seedCheckpoint(h)

    await expect(h.service.execute({ sessionId, turn: 2 })).rejects.toMatchObject({ code: 'ROLLBACK_FAILED' })
    await expect(h.store.recoverJournal()).resolves.toMatchObject([{ id: 'restore-1', status: 'files-restored' }])
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')

    const recovered = harness({ session: h.session })
    await recovered.service.recover()

    await expect(h.store.recoverJournal()).resolves.toEqual([])
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
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
    await expect(files.runTransaction(
      [fileCheckpoint('file.txt', 'modify', 'before', 'after')],
      async () => ({ appended: true, synchronized: false }),
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
      coverage: 'partial',
      gaps: [{ type: 'workspace', reason: 'capture-failed' }],
      files: [],
      prompt: '',
    }))

    await expect(h.service.summaries({ sessionId })).resolves.toEqual({
      sessionId,
      activity: {
        turns: 3,
        steps: 3,
        checkpoints: 2,
        liveCheckpoints: 2,
      },
      turns: [
        {
          turn: 2,
          coverage: 'complete',
          fileCount: 1,
          createdAt: 100,
          atSeq: 5,
          prompt: 'second prompt',
          promptPreview: 'second prompt',
          files: [{ path: 'file.txt', change: 'modify' }],
          gaps: [],
          rolledBack: false,
          tip: false,
        },
        {
          turn: 3,
          coverage: 'partial',
          fileCount: 0,
          createdAt: 100,
          atSeq: 5,
          // Soft store entry; live events still recover the seeded turn-3 prompt.
          prompt: 'third prompt',
          promptPreview: 'third prompt',
          files: [],
          gaps: [{ type: 'workspace', reason: 'capture-failed' }],
          rolledBack: false,
          tip: false,
        },
      ],
    })
  })

  it('omits undo-shell captures and reports surface-scoped activity', async () => {
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
    await h.service.execute({ sessionId, turn: 2, operation: 'undo' })
    const events = h.adapter.readEvents()
    const ranges = undoShellRanges(events)
    expect(ranges.length).toBeGreaterThan(0)
    expect(events.some(event => event.type === 'user/message' && isUndoId(event.data.id))).toBe(true)
    const shell = ranges[0]!
    await h.store.save(checkpoint({
      id: 'checkpoint-undo-shell',
      turn: shell.turn,
      atSeq: shell.startSeq - 1,
      prompt: 'should not appear',
    }))
    expect(isUndoShellCheckpoint(shell.startSeq - 1, ranges)).toBe(true)

    const summaries = await h.service.summaries({ sessionId })
    expect(summaries.turns.some(turn => turn.prompt === 'should not appear')).toBe(false)
    expect(summaries.turns.map(turn => turn.turn).sort()).toEqual([1, 2])
    expect(summaries.activity.checkpoints).toBe(summaries.turns.length)
    expect(summaries.activity.liveCheckpoints).toBe(summaries.turns.filter(turn => !turn.rolledBack).length)
    expect(summaries.activity.turns).toBeGreaterThan(0)
    expect(summaries.activity.steps).toBeGreaterThan(0)
    // Prune is persisted — reopen must not still see the undo-shell row.
    const listed = await h.store.list(sessionId)
    expect(listed.some(item => item.prompt === 'should not appear')).toBe(false)
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
})

describe('checkpoint rollback Host Remote', () => {
  it('publishes an independent strict namespace without client-controlled paths or boundaries', () => {
    expect(checkpointRemoteInfo.descriptors).toHaveLength(3)
    expect(checkpointRemoteInfo.descriptors).toEqual(expect.arrayContaining([
      expect.objectContaining({ namespace: 'checkpointRollback', method: 'preview', service: 'checkpointRollback' }),
      expect.objectContaining({ namespace: 'checkpointRollback', method: 'execute', service: 'checkpointRollback' }),
      expect.objectContaining({ namespace: 'checkpointRollback', method: 'summaries', service: 'checkpointRollback' }),
    ]))
    expect(checkpointHostContribution.invocations).toEqual(checkpointRemoteInfo.descriptors)
    expect(checkpointRollbackRequestSchema.parse({ sessionId, turn: 2 })).toEqual({ sessionId, turn: 2 })
    expect(checkpointRollbackRequestSchema.parse({ sessionId, turn: 2, operation: 'undo' }))
      .toEqual({ sessionId, turn: 2, operation: 'undo' })
    expect(() => checkpointRollbackRequestSchema.parse({ sessionId, turn: 2, operation: 'replace' })).toThrow()
    expect(() => checkpointRollbackRequestSchema.parse({ sessionId, turn: 2, atSeq: 5 })).toThrow()
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
