import { isAbsolute, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-tools'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { isRollbackId, isUndoId } from '../../identity.ts'
import { isRollbackScaffoldEvent } from './activity.ts'
import { captureCheckpoint } from './capture.ts'
import { readSnapshot, snapshotHash, unsafePath } from './files.ts'
import type { CurrentSnapshot } from './files.ts'
import type { CheckpointStore } from './store.ts'
import type { FileCheckpoint } from './types.ts'
import { diffSnapshots, scanWorkspace } from './workspace-snapshot.ts'

type LiveAgent = NonNullable<ReturnType<Context['agents']['get']>>

interface TrackedFile {
  readonly path: string
  readonly before: CurrentSnapshot
}

function isFileMutationTool(name: string): boolean {
  return /^(?:write_file|edit_file|write|edit|str_replace(?:_editor)?|apply_patch)$/i.test(name)
}

function isShellTool(name: string): boolean {
  return /^(?:shell|bash|terminal|run_code|pwsh)/i.test(name)
}

function filePathFromToolArgs(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  for (const key of ['path', 'file_path', 'filePath', 'target'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

function agentFromActor(actor: object | undefined, actors: Map<object, LiveAgent>): LiveAgent | undefined {
  if (actor === undefined) return undefined
  const mapped = actors.get(actor)
  if (mapped !== undefined) return mapped
  // Desktop fires tools/execute with an agent carrier, so non-global listeners
  // never populate `actors`. write-intent still receives the same exec object,
  // which carries `.agent` — use it directly.
  if (!('agent' in actor)) return undefined
  const agent = (actor as { agent?: LiveAgent }).agent
  return agent
}

interface PendingTurn {
  readonly agent: LiveAgent
  prompt: UserMessage | null
  turnStart: SessionEvent<'turn/start'> | null
  readonly files: Map<string, TrackedFile>
  readonly capturing: Set<string>
  incomplete: boolean
  /**
   * Undo shells / rollback notices are Host scaffolding. Capturing them would
   * append fake timeline checkpoints that look like new conversation rounds.
   */
  suppressCheckpoint: boolean
}

function isScaffoldUserPrompt(event: SessionEvent<'user/message'>): boolean {
  return isUndoId(event.data.id) || isRollbackId(event.data.id) || isRollbackScaffoldEvent(event)
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
        // Always key by Session id. agent.id may diverge from session.id on newer
        // Desktop builds; session/event listeners only see session.id.
        const sessionId = payload.agent.session.id
        const current = this.turns.get(sessionId)
        const startsTurn = current === undefined
          || (current.turnStart !== null && current.turnStart.data.turn !== payload.turn)
        if (!this.closed && startsTurn && payload.agent.session.header.origin !== 'subagent') {
          this.turns.set(sessionId, {
            agent: payload.agent,
            prompt: payload.messages.find(message => message.source.kind === 'user') ?? null,
            turnStart: null,
            files: new Map(),
            capturing: new Set(),
            incomplete: false,
            suppressCheckpoint: false,
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
            suppressCheckpoint: false,
          }
          current.turnStart = event
          this.turns.set(session.id, current)
        } else if (event.type === 'user/message') {
          const current = this.turns.get(session.id)
          if (current === undefined) return
          // Undo copies keep source.kind === 'user' from the original — detect by id.
          if (isScaffoldUserPrompt(event)) {
            current.suppressCheckpoint = true
            return
          }
          // Keep the first direct human prompt. Later user/message events may be
          // injects, steering, or runtime context that would wipe the preview.
          if (event.data.source.kind === 'user'
            && (current.prompt === null || current.prompt.source.kind !== 'user')) {
            current.prompt = event.data
          }
        } else if (event.type === 'turn/end') {
          const current = this.turns.get(session.id)
          if (current?.turnStart?.data.turn === event.data.turn) {
            this.turns.delete(session.id)
            this.finish(current, event)
          }
        }
      }),
      // global: Desktop dispatches tools/execute with an agent carrier; without
      // this flag the host plugin's listener is filtered out and never runs.
      ctx.on('tools/execute', async (exec, next) => {
        if (exec.agent === undefined) return next()
        const current = this.turns.get(exec.agent.session.id)
        this.actors.set(exec, exec.agent)
        try {
          // Observation-policy owns fs/*-intent and never calls next(); snapshot
          // write/edit paths from the tool args before the mutation runs.
          if (current !== undefined && isFileMutationTool(exec.name)) {
            await this.captureToolPath(exec.agent, exec.arguments)
          }
          if (current !== undefined && isShellTool(exec.name)) {
            return await this.captureShellWorkspace(current, next)
          }
          return await next()
        } finally {
          this.actors.delete(exec)
        }
      }, { global: true }),
      // Prepend: policy is a single-slot owner that does not call next(). Capture
      // must wrap it so create/edit before-images still land in the checkpoint.
      ctx.on('fs/write-intent', async (target, actor, next) => {
        await this.captureIntent(target, actor)
        return next()
      }, { prepend: true, global: true }),
      ctx.on('fs/edit-intent', async (target, actor, next) => {
        await this.captureIntent(target, actor)
        return next()
      }, { prepend: true, global: true }),
    )
  }

  awaitPending(): Promise<void> {
    return Promise.allSettled([...this.pending]).then(() => undefined)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const dispose of this.disposers.splice(0)) dispose()
    this.turns.clear()
    this.actors.clear()
    await this.awaitPending()
  }

  private finish(turn: PendingTurn, turnEnd: SessionEvent<'turn/end'>): void {
    const turnStart = turn.turnStart
    if (turnStart === null || turn.suppressCheckpoint) return
    const operation = captureCheckpoint({
      store: {
        save: async checkpoint => {
          if (!this.closed) await this.options.store.save(checkpoint)
        },
      },
      sessionId: turn.agent.session.id,
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

  /**
   * Cline-style workspace before/after scan around shell tools so creates like
   * `Set-Content` land in turn.files. Incomplete only when the scan truncates
   * or fails — not merely because a shell tool ran.
   */
  private async captureShellWorkspace<T>(turn: PendingTurn, run: () => Promise<T>): Promise<T> {
    const workspaceRoot = turn.agent.session.header.cwd
    if (workspaceRoot === undefined) {
      turn.incomplete = true
      return run()
    }
    let before
    try {
      before = await scanWorkspace(workspaceRoot)
    } catch {
      turn.incomplete = true
      return run()
    }
    if (before.truncated) turn.incomplete = true
    try {
      return await run()
    } finally {
      try {
        const after = await scanWorkspace(workspaceRoot)
        if (after.truncated) turn.incomplete = true
        const diff = diffSnapshots(before.files, after.files)
        if (diff.truncated) turn.incomplete = true
        for (const file of diff.files) {
          if (turn.files.has(file.path) || turn.capturing.has(file.path)) continue
          turn.files.set(file.path, {
            path: file.path,
            before: file.beforeText === null
              ? { path: file.path, exists: false, text: null }
              : { path: file.path, exists: true, text: file.beforeText },
          })
        }
      } catch {
        turn.incomplete = true
      }
    }
  }

  private turnOf(agent: LiveAgent): PendingTurn | undefined {
    return this.turns.get(agent.session.id)
  }

  private async captureToolPath(agent: LiveAgent, args: unknown): Promise<void> {
    const path = filePathFromToolArgs(args)
    if (path === null) return
    const workspaceRoot = agent.session.header.cwd
    if (workspaceRoot === undefined) {
      const turn = this.turnOf(agent)
      if (turn !== undefined) turn.incomplete = true
      return
    }
    try {
      const absolutePath = isAbsolute(path) ? path : join(workspaceRoot, path)
      await this.captureAbsolutePath(agent, absolutePath)
    } catch {
      const turn = this.turnOf(agent)
      if (turn !== undefined) turn.incomplete = true
    }
  }

  private async captureIntent(target: { displayPath: string }, actor: object | undefined): Promise<void> {
    const agent = agentFromActor(actor, this.actors)
    if (agent === undefined) {
      // Unattributed writes must not poison unrelated open sessions. Only mark
      // incomplete once the intent maps to a concrete agent turn below.
      return
    }
    try {
      const absolutePath = this.ctx.fs.processPath(target as never)
      await this.captureAbsolutePath(agent, absolutePath)
    } catch {
      const turn = this.turnOf(agent)
      if (turn !== undefined) turn.incomplete = true
    }
  }

  private async captureAbsolutePath(agent: LiveAgent, absolutePath: string): Promise<void> {
    const turn = this.turnOf(agent)
    if (turn === undefined) return
    const workspaceRoot = agent.session.header.cwd
    if (workspaceRoot === undefined) {
      turn.incomplete = true
      return
    }
    try {
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
      // Existence flips (create/delete) always count, including empty-file creates
      // where the after-image is the empty string.
      if (beforeHash === afterHash) continue
      files.push({
        path: tracked.path,
        change: !tracked.before.exists ? 'create' : !after.exists ? 'delete' : 'modify',
        beforeText: tracked.before.exists ? tracked.before.text : null,
        beforeHash,
        afterText: after.exists ? after.text : null,
        afterHash,
      })
    }
    if (turn.incomplete) {
      // Keep write/edit snapshots even when shell (or another gap) marked the turn
      // incomplete — discarding them left created files undeleted on rollback.
      throw Object.assign(new Error('Workspace capture is incomplete'), { files })
    }
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

  awaitPending(): Promise<void> {
    return this.capture?.awaitPending() ?? Promise.resolve()
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
