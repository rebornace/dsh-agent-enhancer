import { describe, expect, it } from 'vitest'
import { MAX_STAGES, RunProgress } from './tracker.ts'

describe('RunProgress', () => {
  it('turns tool calls into ordered stages with detail', () => {
    const run = new RunProgress()
    const first = run.begin('s1', 'read', { path: 'src/app.ts' }, 1_000)
    const second = run.begin('s1', 'bash', { command: 'pnpm check' }, 1_010)
    run.finish('s1', first, { ok: true }, 1_005)

    const view = run.view('s1')
    expect(view.stages).toHaveLength(2)
    expect(view.stages[0]).toMatchObject({ tool: 'read', detail: 'src/app.ts', status: 'done', startedAt: 1_000, endedAt: 1_005 })
    expect(view.stages[1]).toMatchObject({ tool: 'bash', detail: 'pnpm check', status: 'running' })
    expect(view.running).toBe(true)
    expect(view.startedAt).toBe(1_000)
    expect(second).toBeGreaterThan(first)
  })

  it('marks failures and trims the error to one line', () => {
    const run = new RunProgress()
    const id = run.begin('s1', 'bash', { command: 'exit 1' })
    run.finish('s1', id, { ok: false, error: 'boom\nmore detail' })
    const stage = run.view('s1').stages[0]!
    expect(stage.status).toBe('failed')
    expect(stage.error).toBe('boom more detail')
    expect(run.view('s1').running).toBe(false)
  })

  it('starts a fresh list on a new turn', () => {
    const run = new RunProgress()
    run.startTurn('s1', 500)
    expect(run.view('s1')).toEqual({ stages: [], running: false, active: true, startedAt: 500 })
    run.begin('s1', 'read', { path: 'a' })
    run.endTurn('s1')
    expect(run.view('s1').active).toBe(false)
    run.startTurn('s1', 600)
    expect(run.view('s1')).toEqual({ stages: [], running: false, active: true, startedAt: 600 })
    run.begin('s1', 'read', { path: 'b' })
    expect(run.view('s1').stages.map(stage => stage.detail)).toEqual(['b'])
  })

  it('keeps sessions apart and forgets them on clear', () => {
    const run = new RunProgress()
    run.begin('s1', 'read', { path: 'a' })
    run.begin('s2', 'bash', { command: 'ls' })
    expect(run.view('s1').stages.map(stage => stage.detail)).toEqual(['a'])
    expect(run.view('s2').stages.map(stage => stage.detail)).toEqual(['ls'])
    run.clearSession('s1')
    expect(run.view('s1')).toEqual({ stages: [], running: false, active: false })
    expect(run.view('s2').stages).toHaveLength(1)
  })

  it('caps the list at the newest stages', () => {
    const run = new RunProgress()
    for (let i = 0; i < MAX_STAGES + 5; i += 1) run.begin('s1', 'read', { path: `f${i}` })
    const stages = run.view('s1').stages
    expect(stages).toHaveLength(MAX_STAGES)
    expect(stages[stages.length - 1]!.detail).toBe(`f${MAX_STAGES + 4}`)
    expect(stages[0]!.detail).toBe('f5')
  })

  it('ignores a finish for an unknown stage or session', () => {
    const run = new RunProgress()
    run.finish('nope', 1, { ok: true })
    const id = run.begin('s1', 'read', { path: 'a' })
    run.finish('s1', id + 99, { ok: false, error: 'x' })
    expect(run.view('s1').stages[0]!.status).toBe('running')
  })
})
