import { isExpired } from './types.ts'
import type { Pending, PresentedState, Task, TaskId, TaskState } from './types.ts'

export type TurnEndReason = 'ok' | 'error' | 'aborted' | 'stopped'

export type DecideResult = 'ok' | 'no-pending' | 'code-mismatch' | 'expired'

const TERMINAL: Record<TurnEndReason, TaskState> = {
  ok: 'done',
  error: 'failed',
  aborted: 'stopped',
  stopped: 'stopped',
}

/**
 * In-memory task board.
 *
 * Pure state transitions: no host services, no channel code. The adapter layer
 * feeds host events in and renders snapshots out. Persisted data lives elsewhere
 * (bindings only; never pending codes).
 */
export class TaskBoard {
  private readonly tasks = new Map<TaskId, Task>()

  get(id: TaskId): Task | undefined {
    return this.tasks.get(id)
  }

  list(): readonly Task[] {
    return [...this.tasks.values()]
  }

  size(): number {
    return this.tasks.size
  }

  /** Create or refresh a task from a session row. */
  register(id: TaskId, title: string, state: TaskState, at: number): Task {
    const existing = this.tasks.get(id)
    if (existing !== undefined) {
      const next: Task = {
        ...existing,
        title,
        // Do not overwrite a live state (waiting/paused) from a passive list read.
        state: existing.state === 'waiting' || existing.state === 'paused' ? existing.state : state,
        lastActivityAt: Math.max(existing.lastActivityAt, at),
      }
      this.tasks.set(id, next)
      return next
    }
    const created: Task = { id, title, state, lastActivityAt: at }
    this.tasks.set(id, created)
    return created
  }

  rename(id: TaskId, title: string): Task | undefined {
    return this.replace(id, task => ({ ...task, title }))
  }

  /** Newest step summary, used by the card body. */
  note(id: TaskId, line: string, at: number): Task | undefined {
    return this.replace(id, task => ({
      ...task,
      lastLine: line,
      lastActivityAt: Math.max(task.lastActivityAt, at),
    }))
  }

  turnStart(id: TaskId, at: number): Task | undefined {
    return this.replace(id, task => ({
      ...task,
      state: 'running',
      pending: undefined,
      resumeTo: undefined,
      lastActivityAt: Math.max(task.lastActivityAt, at),
    }))
  }

  turnEnd(id: TaskId, reason: TurnEndReason, at: number, error?: string): Task | undefined {
    return this.replace(id, task => ({
      ...task,
      state: TERMINAL[reason],
      pending: undefined,
      resumeTo: undefined,
      lastActivityAt: Math.max(task.lastActivityAt, at),
      ...(reason === 'error' && error !== undefined ? { lastLine: error } : {}),
    }))
  }

  /**
   * Record a pending approval/question. Waits are created while the turn runs;
   * an existing pending is a bug (the host would have had to resolve it first).
   */
  ask(id: TaskId, pending: Pending, at: number): Task | undefined {
    const task = this.tasks.get(id)
    if (task === undefined) return undefined
    if (task.pending !== undefined) throw new Error(`task ${id} already has a pending decision`)
    if (task.state === 'paused') throw new Error(`task ${id} is paused; a decision cannot arrive now`)
    return this.replace(id, current => ({
      ...current,
      state: 'waiting',
      pending,
      lastActivityAt: Math.max(current.lastActivityAt, at),
    }))
  }

  /** Resolve the pending decision with a matching one-shot code. */
  decide(id: TaskId, code: string, now: number): DecideResult {
    const task = this.tasks.get(id)
    if (task?.pending === undefined) return 'no-pending'
    if (task.pending.code !== code) return 'code-mismatch'
    if (isExpired(task.pending, now)) {
      this.replace(id, current => ({ ...current, pending: undefined, state: 'running' }))
      return 'expired'
    }
    this.replace(id, current => ({
      ...current,
      pending: undefined,
      state: 'running',
      lastActivityAt: Math.max(current.lastActivityAt, now),
    }))
    return 'ok'
  }

  /** Drop expired pendings and let their tasks resume running. Returns the dropped codes. */
  expire(now: number): readonly string[] {
    const dropped: string[] = []
    for (const [id, task] of this.tasks) {
      if (task.pending === undefined) continue
      if (!isExpired(task.pending, now)) continue
      dropped.push(task.pending.code)
      this.tasks.set(id, { ...task, pending: undefined, state: 'running' })
    }
    return dropped
  }

  /** Drop a pending without deciding it (another client already handled the request). */
  clearPending(id: TaskId): Pending | undefined {
    const task = this.tasks.get(id)
    if (task?.pending === undefined) return undefined
    const pending = task.pending
    const paused = task.state === 'paused'
    this.tasks.set(id, {
      ...task,
      pending: undefined,
      state: paused ? 'paused' : 'running',
      resumeTo: paused && task.resumeTo === 'waiting' ? 'running' : task.resumeTo,
    })
    return pending
  }

  /** Soft pause: remember what to return to. No-op when already paused. */
  pause(id: TaskId): Task | undefined {
    const task = this.tasks.get(id)
    if (task === undefined || task.state === 'paused') return task
    if (task.state !== 'running' && task.state !== 'waiting') return task
    return this.replace(id, current => ({
      ...current,
      state: 'paused',
      resumeTo: current.state === 'waiting' ? 'waiting' : 'running',
    }))
  }

  resume(id: TaskId, now: number): Task | undefined {
    const task = this.tasks.get(id)
    if (task === undefined || task.state !== 'paused') return task
    const resumeTo = task.resumeTo ?? 'running'
    // A pending that expired while paused cannot be resumed into `waiting`.
    const pending = task.pending !== undefined && isExpired(task.pending, now) ? undefined : task.pending
    const state: TaskState = pending === undefined ? 'running' : resumeTo
    return this.replace(id, current => ({
      ...current,
      state,
      pending,
      resumeTo: undefined,
      lastActivityAt: Math.max(current.lastActivityAt, now),
    }))
  }

  remove(id: TaskId): boolean {
    return this.tasks.delete(id)
  }

  /** Offline is a presentation fact, not a stored state. */
  presented(id: TaskId, hostOnline: boolean): PresentedState | undefined {
    const task = this.tasks.get(id)
    if (task === undefined) return undefined
    return hostOnline ? task.state : 'offline'
  }

  private replace(id: TaskId, update: (task: Task) => Task): Task | undefined {
    const task = this.tasks.get(id)
    if (task === undefined) return undefined
    const next = update(task)
    this.tasks.set(id, next)
    return next
  }
}
