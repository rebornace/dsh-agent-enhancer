/**
 * Stage list for the current turn: what the agent is doing right now, in order.
 *
 * Not a plan and not a todo list — it is derived from the tool calls that
 * actually happened, so it cannot drift from the run. Kept in memory only:
 * losing it on restart costs nothing, and it is dropped when the session goes.
 */

import { stageDetail } from './labels.ts'

export interface RunStage {
  readonly id: number
  readonly tool: string
  readonly detail?: string
  readonly status: 'running' | 'done' | 'failed'
  readonly startedAt: number
  readonly endedAt?: number
  readonly error?: string
}

export interface RunProgressView {
  readonly stages: readonly RunStage[]
  /** True while at least one stage is still running. */
  readonly running: boolean
  /** When the current turn's first stage started. */
  readonly startedAt?: number
}

/** Keep the view short enough to read and to poll. */
export const MAX_STAGES = 30

interface SessionRun {
  stages: RunStage[]
  seq: number
  startedAt: number | undefined
}

export class RunProgress {
  private readonly runs = new Map<string, SessionRun>()

  /** Record a tool call starting; returns its stage id. */
  begin(sessionId: string, tool: string, args: unknown, now = Date.now()): number {
    const run = this.runFor(sessionId)
    run.seq += 1
    const detail = stageDetail(tool, args)
    run.stages.push({
      id: run.seq,
      tool,
      ...(detail === undefined ? {} : { detail }),
      status: 'running',
      startedAt: now,
    })
    if (run.stages.length > MAX_STAGES) run.stages.splice(0, run.stages.length - MAX_STAGES)
    if (run.startedAt === undefined) run.startedAt = now
    return run.seq
  }

  /** Mark a stage finished (or failed with a one-line error). */
  finish(sessionId: string, id: number, outcome: { readonly ok: boolean; readonly error?: string }, now = Date.now()): void {
    const run = this.runs.get(sessionId)
    if (run === undefined) return
    const index = run.stages.findIndex(stage => stage.id === id)
    if (index < 0) return
    const stage = run.stages[index]!
    const error = outcome.ok ? undefined : (outcome.error ?? 'failed')
    run.stages[index] = {
      ...stage,
      status: outcome.ok ? 'done' : 'failed',
      endedAt: now,
      ...(error === undefined ? {} : { error: error.replace(/\s+/gu, ' ').trim().slice(0, 160) }),
    }
  }

  /** A new turn means a new run: forget the previous stages. */
  startTurn(sessionId: string): void {
    const run = this.runFor(sessionId)
    run.stages = []
    run.startedAt = undefined
  }

  view(sessionId: string): RunProgressView {
    const run = this.runs.get(sessionId)
    if (run === undefined) return { stages: [], running: false }
    return {
      stages: run.stages.map(stage => ({ ...stage })),
      running: run.stages.some(stage => stage.status === 'running'),
      ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    }
  }

  clearSession(sessionId: string): void {
    this.runs.delete(sessionId)
  }

  clearAll(): void {
    this.runs.clear()
  }

  private runFor(sessionId: string): SessionRun {
    let run = this.runs.get(sessionId)
    if (run === undefined) {
      run = { stages: [], seq: 0, startedAt: undefined }
      this.runs.set(sessionId, run)
    }
    return run
  }
}
