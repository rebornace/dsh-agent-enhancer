import { describe, expect, it } from 'vitest'
import { TaskBoard } from '../src/host/remote/task-board.ts'
import { createPending } from '../src/host/remote/types.ts'

function approval(code: string, at = 0, ttlMs?: number) {
  return createPending({ kind: 'approval', sessionId: 's1', prompt: '写入 report.xlsx', code, ...(ttlMs === undefined ? {} : { ttlMs }) }, at)
}

describe('TaskBoard', () => {
  it('tracks turn start and terminal outcomes', () => {
    const board = new TaskBoard()
    board.register('s1', '周报导出', 'done', 10)
    expect(board.get('s1')?.state).toBe('done')

    board.turnStart('s1', 20)
    expect(board.get('s1')?.state).toBe('running')

    board.turnEnd('s1', 'ok', 30)
    expect(board.get('s1')?.state).toBe('done')

    board.turnStart('s1', 40)
    board.turnEnd('s1', 'error', 50, '模型超时')
    expect(board.get('s1')?.state).toBe('failed')
    expect(board.get('s1')?.lastLine).toBe('模型超时')

    board.turnStart('s1', 60)
    board.turnEnd('s1', 'aborted', 70)
    expect(board.get('s1')?.state).toBe('stopped')
  })

  it('moves to waiting on a pending decision and back on a matching code', () => {
    const board = new TaskBoard()
    board.register('s1', '周报导出', 'running', 0)
    board.ask('s1', approval('a3f9'), 100)

    const waiting = board.get('s1')
    expect(waiting?.state).toBe('waiting')
    expect(waiting?.pending?.code).toBe('a3f9')

    expect(board.decide('s1', 'zzzz', 110)).toBe('code-mismatch')
    expect(board.get('s1')?.state).toBe('waiting')

    expect(board.decide('s1', 'a3f9', 120)).toBe('ok')
    expect(board.get('s1')?.state).toBe('running')
    expect(board.get('s1')?.pending).toBeUndefined()
  })

  it('expires a pending decision instead of resolving it', () => {
    const board = new TaskBoard()
    board.register('s1', '周报导出', 'running', 0)
    board.ask('s1', approval('a3f9', 0, 100), 0)

    expect(board.decide('s1', 'a3f9', 200)).toBe('expired')
    expect(board.get('s1')?.pending).toBeUndefined()
    expect(board.get('s1')?.state).toBe('running')
  })

  it('sweeps expired pendings and reports their codes', () => {
    const board = new TaskBoard()
    board.register('s1', 'A', 'running', 0)
    board.register('s2', 'B', 'running', 0)
    board.ask('s1', approval('a3f9', 0, 100), 0)
    board.ask('s2', approval('k2m7', 0, 500), 0)

    expect(board.expire(200)).toEqual(['a3f9'])
    expect(board.get('s1')?.state).toBe('running')
    expect(board.get('s2')?.state).toBe('waiting')
  })

  it('refuses a second pending or a pending on a paused task', () => {
    const board = new TaskBoard()
    board.register('s1', 'A', 'running', 0)
    board.ask('s1', approval('a3f9'), 0)
    expect(() => board.ask('s1', approval('k2m7'), 1)).toThrow(/already has a pending/)

    const other = new TaskBoard()
    other.register('s1', 'A', 'running', 0)
    other.pause('s1')
    expect(() => other.ask('s1', approval('a3f9'), 1)).toThrow(/paused/)
  })

  it('pauses and resumes to the previous state', () => {
    const board = new TaskBoard()
    board.register('s1', 'A', 'running', 0)

    board.pause('s1')
    expect(board.get('s1')?.state).toBe('paused')
    expect(board.get('s1')?.resumeTo).toBe('running')

    board.resume('s1', 10)
    expect(board.get('s1')?.state).toBe('running')
    expect(board.get('s1')?.resumeTo).toBeUndefined()
  })

  it('does not resume into waiting when the pending expired while paused', () => {
    const board = new TaskBoard()
    board.register('s1', 'A', 'running', 0)
    board.ask('s1', approval('a3f9', 0, 100), 0)
    board.pause('s1')
    expect(board.get('s1')?.resumeTo).toBe('waiting')

    board.resume('s1', 200)
    expect(board.get('s1')?.state).toBe('running')
    expect(board.get('s1')?.pending).toBeUndefined()
  })

  it('derives offline without storing it', () => {
    const board = new TaskBoard()
    board.register('s1', 'A', 'running', 0)
    expect(board.presented('s1', false)).toBe('offline')
    expect(board.get('s1')?.state).toBe('running')
    expect(board.presented('s1', true)).toBe('running')
  })

  it('does not let a passive list read overwrite waiting or paused', () => {
    const board = new TaskBoard()
    board.register('s1', 'A', 'running', 0)
    board.ask('s1', approval('a3f9'), 0)
    board.register('s1', 'A renamed', 'done', 5)
    expect(board.get('s1')?.state).toBe('waiting')
    expect(board.get('s1')?.title).toBe('A renamed')
  })
})
