import { isExpired } from './types.ts'
import type { Pending, Task, TaskId } from './types.ts'
import type { RemoteCommand } from './commands.ts'

export type Decision = 'approve' | 'reject'

export type RouteFailure =
  | 'not-a-decision'
  | 'no-pending'
  | 'unknown-code'
  | 'ambiguous'
  | 'expired'

interface TaskWithPending extends Task {
  readonly pending: Pending
}

function withKind(task: Task, kind: Pending['kind']): task is TaskWithPending {
  return task.pending !== undefined && task.pending.kind === kind
}

function activeCodes(tasks: readonly TaskWithPending[], now: number): readonly string[] {
  return tasks.filter(task => !isExpired(task.pending, now)).map(task => task.pending.code)
}

/**
 * Route an approve/reject command to exactly one pending approval.
 *
 * The command may carry a code; without one it only succeeds when the chat has
 * exactly one live approval. It never falls back to "the most recent one" —
 * approving the wrong task is worse than asking again.
 */
export type DecisionRoute =
  | {
    readonly ok: true
    readonly taskId: TaskId
    readonly pending: Pending
    readonly decision: Decision
  }
  | {
    readonly ok: false
    readonly reason: RouteFailure
    readonly codes?: readonly string[]
  }

export function routeDecision(
  tasks: readonly Task[],
  command: RemoteCommand,
  now: number,
): DecisionRoute {
  if (command.kind !== 'approve' && command.kind !== 'reject') {
    return { ok: false, reason: 'not-a-decision' }
  }
  const decision: Decision = command.kind === 'approve' ? 'approve' : 'reject'
  const approvals = tasks.filter(task => withKind(task, 'approval'))
  const codes = activeCodes(approvals, now)

  if (command.code !== undefined) {
    const hit = approvals.find(task => task.pending.code === command.code)
    if (hit === undefined) return { ok: false, reason: 'unknown-code', codes }
    if (isExpired(hit.pending, now)) return { ok: false, reason: 'expired', codes }
    return { ok: true, taskId: hit.id, pending: hit.pending, decision }
  }

  const live = approvals.filter(task => !isExpired(task.pending, now))
  if (live.length === 0) {
    return { ok: false, reason: approvals.length > 0 ? 'expired' : 'no-pending' }
  }
  const only = live[0]
  if (only === undefined) return { ok: false, reason: 'no-pending' }
  if (live.length > 1) return { ok: false, reason: 'ambiguous', codes: live.map(task => task.pending.code) }
  return { ok: true, taskId: only.id, pending: only.pending, decision }
}

export type AnswerRoute =
  | {
    readonly ok: true
    readonly taskId: TaskId
    readonly pending: Pending
    readonly text: string
  }
  | {
    readonly ok: false
    readonly reason: 'not-an-answer' | RouteFailure
    readonly codes?: readonly string[]
  }

/** Route a free-text answer to exactly one pending question. */
export function routeAnswer(
  tasks: readonly Task[],
  command: RemoteCommand,
  now: number,
): AnswerRoute {
  if (command.kind !== 'answer') return { ok: false, reason: 'not-an-answer' }
  const questions = tasks.filter(task => withKind(task, 'question'))
  const codes = activeCodes(questions, now)

  if (command.code !== undefined) {
    const hit = questions.find(task => task.pending.code === command.code)
    if (hit === undefined) return { ok: false, reason: 'unknown-code', codes }
    if (isExpired(hit.pending, now)) return { ok: false, reason: 'expired', codes }
    return { ok: true, taskId: hit.id, pending: hit.pending, text: command.text }
  }

  const live = questions.filter(task => !isExpired(task.pending, now))
  if (live.length === 0) {
    return { ok: false, reason: questions.length > 0 ? 'expired' : 'no-pending' }
  }
  const only = live[0]
  if (only === undefined) return { ok: false, reason: 'no-pending' }
  if (live.length > 1) return { ok: false, reason: 'ambiguous', codes: live.map(task => task.pending.code) }
  return { ok: true, taskId: only.id, pending: only.pending, text: command.text }
}
