import { isAbsolute, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-tools'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { captureCheckpoint } from './capture.ts'
import { readSnapshot, snapshotHash, unsafePath } from './files.ts'
import type { CurrentSnapshot } from './files.ts'
import type { CheckpointStore } from './store.ts'
import type { FileCheckpoint } from './types.ts'

type LiveAgent = NonNullable<ReturnType<Context['agents']['get']>>

interface TrackedFile {
  readonly path: string
  readonly before: CurrentSnapshot
}

interface PendingTurn {
  readonly agent: LiveAgent
  prompt: UserMessage | null
  turnStart: SessionEvent<'turn/start'> | null
  readonly files: Map<string, TrackedFile>
  readonly capturing: Set<string>
  incomplete: boolean
}

export interface CheckpointCaptureOptions {
  readonly store: CheckpointStore
  readonly pluginVersion: string
}

export class DshCheckpointCapture {
  private readonly turns = new Map<SessionId, PendingTurn>()
  private readonly actors = new Map<object, LiveAgent>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly disposers: Array<() => void> = []
  private closed = false

  constructor(private readonly ctx: Context, private readonly options: CheckpointCaptureOptions) {
    this.disposers.push(
      ctx.on('agent/pre-step', async (payload, next) => {
        const current = this.turns.get(payload.agent.id)
        const startsTurn = current === undefined
          || (current.turnStart !== null && current.turnStart.data.turn !== payload.turn)
        if (!this.closed && startsTurn && payload.agent.session.header.origin !== 'subagent') {
          this.turns.set(payload.agent.id, {
            agent: payload.agent,
            prompt: payload.messages.find(message => message.source.kind === 'user') ?? null,
            turnStart: null,
            files: new Map(),
            capturing: new Set(),
            incomplete: false,
          })
        }
        return next()
      }),
      ctx.on('session/event', (session, event) => {
        if (this.closed) return
        if (event.type === 'turn/start') {
          const existing = this.turns.get(session.id)
          const agent = existing?.agent ?? this.ctx.agents.get(session.id)
          if (agent === undefined || agent.session !== session) return
          const current: PendingTurn = existing ?? {
            agent,
            prompt: null,
            turnStart: null,
            files: new Map(),
            capturing: new Set(),
            incomplete: false,
          }
          current.turnStart = event
          this.turns.set(session.id, current)
        } else if (event.type === 'user/message') {
          const current = this.turns.get(session.id)
          if (current !== undefined) current.prompt = event.data
        } else if (event.type === 'turn/end') {
          const current = this.turns.get(session.id)
          if (current?.turnStart?.data.turn === event.data.turn) {
            this.turns.delete(session.id)
            this.finish(current, event)
          }
        }
      }),
      ctx.on('tools/execute', async (exec, next) => {
        if (exec.agent === undefined) return next()
        const current = this.turns.get(exec.agent.id)
        if (current !== undefined && /^(?:shell|bash|terminal|run_code)/.test(exec.name)) current.incomplete = true
        this.actors.set(exec, exec.agent)
        try {
          return await next()
        } finally {
          this.actors.delete(exec)
        }
      }),
      ctx.on('fs/write-intent', async (target, actor, next) => {
        await this.captureIntent(target, actor)
        return next()
      }),
      ctx.on('fs/edit-intent', async (target, actor, next) => {
        await this.captureIntent(target, actor)
        return next()
      }),
    )
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const dispose of this.disposers.splice(0)) dispose()
    this.turns.clear()
    this.actors.clear()
    await Promise.allSettled([...this.pending])
  }

  private finish(turn: PendingTurn, turnEnd: SessionEvent<'turn/end'>): void {
    const turnStart = turn.turnStart
    if (turnStart === null) return
    const operation = captureCheckpoint({
      store: {
        save: async checkpoint => {
          if (!this.closed) await this.options.store.save(checkpoint)
        },
      },
      sessionId: turn.agent.id,
      session: {
        format: turn.agent.session.header.version,
        preset: turn.agent.session.header.agentPreset ?? null,
      },
      pluginVersion: this.options.pluginVersion,
      turnStart,
      turnEnd,
      prompt: turn.prompt ?? { content: [], source: { kind: 'user' } },
      flushSession: async () => {
        await (this.ctx.get('sessions') as unknown as SessionStore).flush(turn.agent.session)
      },
      captureFiles: () => this.captureFiles(turn),
    }).catch(() => null)
    this.pending.add(operation)
    void operation.finally(() => { this.pending.delete(operation) })
  }

  private async captureIntent(target: { displayPath: string }, actor: object | undefined): Promise<void> {
    const agent = actor === undefined ? undefined : this.actors.get(actor)
    if (agent === undefined) {
      for (const turn of this.turns.values()) turn.incomplete = true
      return
    }
    const turn = this.turns.get(agent.id)
    if (turn === undefined) return
    const workspaceRoot = agent.session.header.cwd
    if (workspaceRoot === undefined) {
      turn.incomplete = true
      return
    }
    try {
      const absolutePath = this.ctx.fs.processPath(target as never)
      const relativePath = relative(workspaceRoot, absolutePath)
      if (relativePath === '' || relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
        turn.incomplete = true
        return
      }
      const path = relativePath.split(sep).join('/')
      if (unsafePath(path)) {
        turn.incomplete = true
        return
      }
      if (turn.files.has(path) || turn.capturing.has(path)) return
      turn.capturing.add(path)
      try {
        const before = await readSnapshot(workspaceRoot, path)
        turn.files.set(path, { path, before })
      } finally {
        turn.capturing.delete(path)
      }
    } catch {
      turn.incomplete = true
    }
  }

  private async captureFiles(turn: PendingTurn): Promise<readonly FileCheckpoint[]> {
    const files: FileCheckpoint[] = []
    for (const tracked of turn.files.values()) {
      const after = await readSnapshot(turn.agent.session.header.cwd!, tracked.path)
      const beforeHash = snapshotHash(tracked.before)
      const afterHash = snapshotHash(after)
      if (beforeHash === afterHash) continue
      files.push({
        path: tracked.path,
        change: !tracked.before.exists ? 'create' : !after.exists ? 'delete' : 'modify',
        beforeText: tracked.before.exists ? tracked.before.text : null,
        beforeHash,
        afterHash,
      })
    }
    if (turn.incomplete) throw new Error('Workspace capture is incomplete')
    return files
  }
}

export class DshCheckpointCaptureSwitch {
  private capture: DshCheckpointCapture | undefined
  private readonly closing = new Set<Promise<void>>()
  private closed = false

  constructor(private readonly ctx: Context, private readonly options: CheckpointCaptureOptions) {}

  setEnabled(enabled: boolean): void {
    if (this.closed) return
    if (enabled) {
      if (this.capture === undefined) this.capture = new DshCheckpointCapture(this.ctx, this.options)
      return
    }
    this.stop()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stop()
    await Promise.allSettled([...this.closing])
  }

  private stop(): void {
    const current = this.capture
    this.capture = undefined
    if (current === undefined) return
    const closing = current.close()
    this.closing.add(closing)
    void closing.finally(() => { this.closing.delete(closing) })
  }
}
