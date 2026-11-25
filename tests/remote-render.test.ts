import { describe, expect, it } from 'vitest'
import { decisionActions, renderTaskCard, renderTaskList, splitForChannel } from '../src/host/remote/render.ts'
import { TaskBoard } from '../src/host/remote/task-board.ts'
import { createPending } from '../src/host/remote/types.ts'
import type { ChannelCapabilities } from '../src/host/remote/types.ts'

const textOnly: ChannelCapabilities = {
  buttons: false,
  editMessage: false,
  threads: false,
  media: 'none',
  markdown: false,
  maxChars: 1800,
  privateOnly: true,
}

const rich: ChannelCapabilities = { ...textOnly, buttons: true, markdown: true }

function waitingBoard() {
  const board = new TaskBoard()
  board.register('s1', '周报导出', 'running', 0)
  board.ask('s1', createPending({
    kind: 'approval',
    sessionId: 's1',
    prompt: '要写入 2 个文件：report.xlsx、summary.md',
    risk: 'write',
    code: 'a3f9',
  }, 0), 0)
  return board
}

describe('renderTaskCard', () => {
  it('shows the code and a text fallback on channels without buttons', () => {
    const task = waitingBoard().get('s1')
    expect(task).toBeDefined()
    if (task === undefined) return
    const card = renderTaskCard(task, 3, textOnly)
    expect(card).toContain('【3】周报导出 · 待决定')
    expect(card).toContain('report.xlsx')
    expect(card).toContain('批准 a3f9')
    expect(card).toContain('拒绝 a3f9')
    expect(card).not.toContain('点下方按钮')
  })

  it('mentions buttons on channels that have them', () => {
    const task = waitingBoard().get('s1')
    if (task === undefined) throw new Error('missing task')
    expect(renderTaskCard(task, 1, rich)).toContain('点下方按钮')
  })

  it('renders running, done, and offline states', () => {
    const board = new TaskBoard()
    board.register('s1', '网页重构', 'running', 0)
    board.note('s1', '读取 src/host/index.ts', 5)
    const task = board.get('s1')
    if (task === undefined) throw new Error('missing task')
    expect(renderTaskCard(task, 1, textOnly)).toContain('最近：读取 src/host/index.ts')

    board.turnEnd('s1', 'ok', 10)
    const done = board.get('s1')
    if (done === undefined) throw new Error('missing task')
    expect(renderTaskCard(done, 1, textOnly)).toContain('已完成')
    expect(renderTaskCard(done, 1, textOnly, 'offline')).toContain('离线')
  })
})

describe('renderTaskList', () => {
  it('marks the task that needs a person', () => {
    const board = waitingBoard()
    board.register('s2', '资料整理', 'done', 0)
    const numbers = new Map([['s1', 1], ['s2', 2]])
    const list = renderTaskList(board.list(), numbers, textOnly)
    expect(list).toContain('1 周报导出  待决定 ← 需要你')
    expect(list).toContain('2 资料整理  已完成')
    expect(list).toContain('切 2')
  })

  it('explains an empty board instead of showing nothing', () => {
    expect(renderTaskList([], new Map(), textOnly)).toContain('当前没有任务')
  })
})

describe('decisionActions', () => {
  it('uses the same words as the text commands', () => {
    const actionList = decisionActions(createPending({
      kind: 'approval',
      sessionId: 's1',
      prompt: '写文件',
      code: 'a3f9',
    }, 0))
    expect(actionList.map(action => action.label)).toEqual(['批准', '拒绝', '详情'])
    expect(actionList[0]?.command).toBe('批准 a3f9')
    expect(actionList[1]?.command).toBe('拒绝 a3f9')
  })
})

describe('splitForChannel', () => {
  it('keeps short text untouched', () => {
    expect(splitForChannel('你好', 1800)).toEqual(['你好'])
  })

  it('splits 1801 characters into two marked chunks', () => {
    const text = 'a'.repeat(1801)
    const chunks = splitForChannel(text, 1800)
    expect(chunks).toHaveLength(2)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1800)
    expect(chunks[0]).toContain('(1/2)')
    expect(chunks[1]).toContain('(2/2)')
  })
})
