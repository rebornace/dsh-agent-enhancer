import { describe, expect, it } from 'vitest'
import type { RunProgressStageWire } from '../../host/rpc.ts'
import { stageVerb, summarizeRun } from './summary.ts'

const stage = (id: number, status: RunProgressStageWire['status'], tool = 'read'): RunProgressStageWire => ({
  id,
  tool,
  status,
  startedAt: id,
})

describe('summarizeRun', () => {
  it('counts finished, failed and the step that is running', () => {
    const view = summarizeRun([
      stage(1, 'done', 'bash'),
      stage(2, 'failed', 'edit'),
      stage(3, 'running', 'browser_click'),
    ])
    expect(view).toMatchObject({ total: 3, done: 1, failed: 1, running: true })
    expect(view.current).toMatchObject({ id: 3, tool: 'browser_click' })
  })

  it('is idle when nothing is running', () => {
    const view = summarizeRun([stage(1, 'done'), stage(2, 'done')])
    expect(view.running).toBe(false)
    expect(view.current).toBeUndefined()
    expect(view).toMatchObject({ total: 2, done: 2, failed: 0 })
  })

  it('handles an empty run', () => {
    expect(summarizeRun([])).toMatchObject({ total: 0, done: 0, failed: 0, running: false })
  })
})

describe('stageVerb', () => {
  it('maps tool ids to one of the four verbs the locale knows', () => {
    expect(stageVerb('bash')).toBe('shell')
    expect(stageVerb('shell_exec')).toBe('shell')
    expect(stageVerb('read')).toBe('read')
    expect(stageVerb('read_file')).toBe('read')
    expect(stageVerb('edit')).toBe('write')
    expect(stageVerb('write_file')).toBe('write')
    expect(stageVerb('browser_click')).toBe('browser')
    expect(stageVerb('browser_navigate')).toBe('browser')
    expect(stageVerb('todo_write')).toBe('other')
  })
})
