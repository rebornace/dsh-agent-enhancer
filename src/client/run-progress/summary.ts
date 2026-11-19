/**
 * Shape of the run line under the composer: how many stages, what is running,
 * what failed. Kept pure so the wording (counts, current step) is testable.
 */

import type { RunProgressStageWire } from '../../host/rpc.ts'

export interface RunProgressSummary {
  readonly total: number
  readonly done: number
  readonly failed: number
  readonly running: boolean
  readonly current?: RunProgressStageWire
}

export function summarizeRun(stages: readonly RunProgressStageWire[]): RunProgressSummary {
  const current = stages.find(stage => stage.status === 'running')
  return {
    total: stages.length,
    done: stages.filter(stage => stage.status === 'done').length,
    failed: stages.filter(stage => stage.status === 'failed').length,
    running: current !== undefined,
    ...(current === undefined ? {} : { current }),
  }
}

/** Which verb to show for a tool id (the locale owns the words). */
export type StageVerb = 'shell' | 'read' | 'write' | 'browser' | 'other'

export function stageVerb(tool: string): StageVerb {
  const name = tool.toLowerCase()
  if (name.includes('shell') || name === 'bash' || name === 'terminal') return 'shell'
  if (name.startsWith('browser_')) return 'browser'
  if (name === 'read' || name === 'view' || name.includes('read_file')) return 'read'
  if (name === 'edit' || name === 'write' || name === 'apply_patch' || name.includes('write_file')) return 'write'
  return 'other'
}
