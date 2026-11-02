import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyCheckpointRollback, CheckpointRollbackRemoteService, checkpointHostContribution } from '../src/host/index.ts'
import { checkpointRemoteInfo, checkpointRollbackRequestSchema } from '../src/host/rpc.ts'
import { CheckpointFiles } from '../src/host/checkpoint/files.ts'
import type { CheckpointFileOperations } from '../src/host/checkpoint/files.ts'
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
  operations?: CheckpointFileOperations
  synchronize?: (signal: AbortSignal) => Promise<void>
  createId?: () => string
} = {}): Harness {
  const session = options.session ?? makeSession()
  appendSystem(session)
  appendTurn(session, 1, 'first prompt', 'first answer')
  appendTurn(session, 2, 'second prompt', 'second answer')
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
    ])
    expect(h.session.surface.nodes).toEqual([1, 3, 4, 7, 8])

    const first = await h.service.preview({ sessionId, turn: 2 })
    expect(first).toMatchObject({
      sessionId,
      turn: 2,
      messages: [
        { seq: 7, type: 'user/message', text: 'second prompt' },
        { seq: 8, type: 'assistant/message', text: 'second answer' },
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

  it('rejects a first-turn boundary even when a stored checkpoint names it', async () => {
    const h = harness()
    await seedCheckpoint(h, checkpoint({ turn: 1, atSeq: 0, prompt: 'first prompt' }))

    const preview = await h.service.preview({ sessionId, turn: 1 })

    expect(preview.unavailable).toContain('first-turn')
    await expect(h.service.execute({ sessionId, turn: 1 })).rejects.toMatchObject({ code: 'ROLLBACK_UNAVAILABLE' })
  })

  it('shows incomplete checkpoint gaps and refuses execution', async () => {
    const h = harness()
    await seedCheckpoint(h, checkpoint({
      coverage: 'partial',
      gaps: [{ type: 'prompt', reason: 'non-text-content' }],
      prompt: '',
    }))

    const preview = await h.service.preview({ sessionId, turn: 2 })

    expect(preview.unavailable).toEqual(expect.arrayContaining(['incomplete-checkpoint', 'prompt-non-text-content']))
    await expect(h.service.execute({ sessionId, turn: 2 })).rejects.toMatchObject({ code: 'ROLLBACK_UNAVAILABLE' })
  })

  it('refuses compaction, subagent Sessions, and unknown boundary structures', async () => {
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

    const child = harness({ session: makeSession('subagent') })
    await seedCheckpoint(child)
    await expect(child.service.preview({ sessionId, turn: 2 }))
      .resolves.toMatchObject({ unavailable: expect.arrayContaining(['subagent-session']) })

    const unknown = harness()
    await seedCheckpoint(unknown, checkpoint({ atSeq: 3 }))
    await expect(unknown.service.preview({ sessionId, turn: 2 }))
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
    const h = harness({
      operations,
      synchronize: async () => { expect(maintenanceDepth).toBe(1) },
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
  })

  it('restores files and model-visible surface and returns only the plain-text draft', async () => {
    const h = harness()
    await seedCheckpoint(h)
    const originalLength = (h.adapter.readEvents() as readonly SessionEvent[]).length

    const result = await h.service.execute({ sessionId, turn: 2 })

    expect(result).toEqual({ sessionId, turn: 2, draft: 'second prompt' })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
    expect(h.session.deriveMessages().map(message => message.id)).toEqual([
      'system', 'user-1', 'assistant-1', expect.stringMatching(/^dsh-composer-enhancer:rollback:2:/),
    ])
    const events = h.adapter.readEvents()
    expect(events).toHaveLength(originalLength + 1)
    expect(events.at(-1)).toMatchObject({
      type: 'user/message',
      surfaceOp: { op: 'replace', startSeq: 7, endSeq: 8 },
      sourceEventSeqs: [7, 8],
      data: {
        role: 'user',
        source: { kind: 'checkpoint-rollback', form: 'notice' },
        content: [{ type: 'text', text: expect.stringContaining('turn 2') }],
      },
    })
    expect(events.filter(event => event.type === 'user/message')).toHaveLength(3)
    await expect(h.store.recoverJournal()).resolves.toEqual([])
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

    expect(originalSession.surface.nodes).toEqual([1, 3, 4, 7, 8])
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
      'system', expect.stringMatching(/^dsh-composer-enhancer:rollback:1:/),
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
    ])
    expect(h.adapter.readEvents()).toHaveLength(originalLength + 3)
    expect(h.adapter.readEvents().filter(event => event.type === 'user/message')).toHaveLength(4)
    await expect(h.store.recoverJournal()).resolves.toEqual([])
  })

  it('rejects undo after a file conflict or any newer Session event', async () => {
    const conflicted = harness()
    await seedCheckpoint(conflicted)
    await conflicted.service.execute({ sessionId, turn: 2 })
    await writeFile(join(workspaceRoot, 'file.txt'), 'new file state', 'utf8')

    await expect(conflicted.service.preview({ sessionId, turn: 2, operation: 'undo' }))
      .resolves.toMatchObject({ conflicts: [{ reason: 'hash-mismatch' }] })
    await expect(conflicted.service.execute({ sessionId, turn: 2, operation: 'undo' }))
      .rejects.toMatchObject({ code: 'ROLLBACK_CONFLICT' })

    const changed = harness()
    await seedCheckpoint(changed)
    await changed.service.execute({ sessionId, turn: 2 })
    appendTurn(changed.session, 3, 'new prompt', 'new answer')

    await expect(changed.service.preview({ sessionId, turn: 2, operation: 'undo' }))
      .resolves.toMatchObject({ unavailable: expect.arrayContaining(['session-changed']) })
    await expect(changed.service.execute({ sessionId, turn: 2, operation: 'undo' }))
      .rejects.toMatchObject({ code: 'ROLLBACK_UNAVAILABLE' })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
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

    await expect(h.service.preview({ sessionId, turn: 2, operation: 'undo' }))
      .resolves.toMatchObject({ unavailable: expect.arrayContaining(['session-changed']) })
    await h.service.execute({ sessionId, turn: 1, operation: 'undo' })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', expect.stringContaining('turn 2'),
    ])

    await h.service.execute({ sessionId, turn: 2, operation: 'undo' })
    await h.service.execute({ sessionId, turn: 2 })
    await expect(readFile(join(workspaceRoot, 'file.txt'), 'utf8')).resolves.toBe('before')
    expect(h.session.deriveMessages().map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([
      'system', 'first prompt', 'first answer', expect.stringContaining('turn 2'),
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
      if (appends === 2) throw new Error('append persisted before the failure')
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

describe('checkpoint rollback Host Remote', () => {
  it('publishes an independent strict namespace without client-controlled paths or boundaries', () => {
    expect(checkpointRemoteInfo.descriptors).toHaveLength(2)
    expect(checkpointRemoteInfo.descriptors).toEqual(expect.arrayContaining([
      expect.objectContaining({ namespace: 'checkpointRollback', method: 'preview', service: 'checkpointRollback' }),
      expect.objectContaining({ namespace: 'checkpointRollback', method: 'execute', service: 'checkpointRollback' }),
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
      code: 'composer-enhancer/forbidden',
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
      code: 'composer-enhancer/rollback-failed',
      message: 'Checkpoint rollback request failed',
      details: { code: 'ROLLBACK_CONFLICT' },
    })
    expect((rejection as Error).message).not.toContain('private concurrent contents')
  })

  it('registers and disposes the independent Host contribution', async () => {
    const h = harness()
    const ctx = new Context()
    contexts.push(ctx)
    const unregister = vi.fn()
    const register = vi.fn(() => unregister)
    ctx.provide('typert', { register } as never)

    applyCheckpointRollback(ctx, h.service)

    expect(register).toHaveBeenCalledWith(checkpointHostContribution)
    expect(ctx.checkpointRollback).toBeInstanceOf(CheckpointRollbackRemoteService)
    await ctx.fiber.dispose()
    expect(unregister).toHaveBeenCalledTimes(1)
  })
})
