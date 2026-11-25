import { describe, expect, it } from 'vitest'
import { routeAnswer, routeDecision } from '../src/host/remote/approval-router.ts'
import { parseCommand } from '../src/host/remote/commands.ts'
import { TaskBoard } from '../src/host/remote/task-board.ts'
import { createPending } from '../src/host/remote/types.ts'

function twoTasks() {
  const board = new TaskBoard()
  board.register('s1', '周报导出', 'running', 0)
  board.register('s2', '网页重构', 'running', 0)
  board.ask('s1', createPending({ kind: 'approval', sessionId: 's1', prompt: '写 report.xlsx', code: 'a3f9' }, 0), 0)
  board.ask('s2', createPending({ kind: 'approval', sessionId: 's2', prompt: '执行 npm test', code: 'k2m7' }, 0), 0)
  return board
}

describe('routeDecision', () => {
  it('routes a coded decision to exactly that task', () => {
    const board = twoTasks()
    const route = routeDecision(board.list(), parseCommand('批准 a3f9'), 10)
    expect(route.ok).toBe(true)
    if (route.ok) {
      expect(route.taskId).toBe('s1')
      expect(route.pending.code).toBe('a3f9')
      expect(route.decision).toBe('approve')
    }
  })

  it('refuses to guess when several approvals are live', () => {
    const board = twoTasks()
    const route = routeDecision(board.list(), parseCommand('批准'), 10)
    expect(route).toEqual({ ok: false, reason: 'ambiguous', codes: ['a3f9', 'k2m7'] })
  })

  it('reports unknown codes and expired codes differently', () => {
    const board = twoTasks()
    expect(routeDecision(board.list(), parseCommand('批准 zzzz'), 10)).toEqual({
      ok: false,
      reason: 'unknown-code',
      codes: ['a3f9', 'k2m7'],
    })

    const late = routeDecision(board.list(), parseCommand('批准 a3f9'), 300_000)
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.reason).toBe('expired')
  })

  it('maps reject and ignores non-decision commands', () => {
    const board = twoTasks()
    const route = routeDecision(board.list(), parseCommand('拒绝 k2m7'), 10)
    expect(route.ok).toBe(true)
    if (route.ok) {
      expect(route.taskId).toBe('s2')
      expect(route.decision).toBe('reject')
    }
    expect(routeDecision(board.list(), parseCommand('任务'), 10)).toEqual({ ok: false, reason: 'not-a-decision' })
  })

  it('is one-shot: after the task board resolves, the code is gone', () => {
    const board = twoTasks()
    const route = routeDecision(board.list(), parseCommand('批准 a3f9'), 10)
    expect(route.ok).toBe(true)
    board.decide('s1', 'a3f9', 10)

    expect(routeDecision(board.list(), parseCommand('批准 a3f9'), 11)).toEqual({
      ok: false,
      reason: 'unknown-code',
      codes: ['k2m7'],
    })
  })
})

describe('routeAnswer', () => {
  function questions() {
    const board = new TaskBoard()
    board.register('s1', '资料整理', 'running', 0)
    board.ask('s1', createPending({
      kind: 'question',
      sessionId: 's1',
      prompt: '选哪个模板？',
      options: ['简洁', '详细'],
      code: 'q7t2',
    }, 0), 0)
    return board
  }

  it('routes an answer with a code', () => {
    const board = questions()
    const route = routeAnswer(board.list(), parseCommand('回答 q7t2 详细'), 10)
    expect(route.ok).toBe(true)
    if (route.ok) {
      expect(route.taskId).toBe('s1')
      expect(route.text).toBe('详细')
    }
  })

  it('allows a code-less answer when exactly one question is live', () => {
    const board = questions()
    const route = routeAnswer(board.list(), parseCommand('回答 完整版'), 10)
    expect(route.ok).toBe(true)
    if (route.ok) expect(route.text).toBe('完整版')
  })

  it('rejects non-answers and expired questions', () => {
    const board = questions()
    expect(routeAnswer(board.list(), parseCommand('批准'), 10)).toEqual({ ok: false, reason: 'not-an-answer' })
    const late = routeAnswer(board.list(), parseCommand('回答 详细'), 300_000)
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.reason).toBe('expired')
  })
})
