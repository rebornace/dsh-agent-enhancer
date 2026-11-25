import { describe, expect, it } from 'vitest'
import { parseCommand } from '../src/host/remote/commands.ts'

describe('parseCommand', () => {
  it('recognises the six words in both languages', () => {
    expect(parseCommand('任务')).toEqual({ kind: 'tasks' })
    expect(parseCommand('tasks')).toEqual({ kind: 'tasks' })
    expect(parseCommand('切 3')).toEqual({ kind: 'switch', number: 3 })
    expect(parseCommand('详情')).toEqual({ kind: 'detail' })
    expect(parseCommand('暂停')).toEqual({ kind: 'pause' })
    expect(parseCommand('继续')).toEqual({ kind: 'resume' })
    expect(parseCommand('批准')).toEqual({ kind: 'approve' })
    expect(parseCommand('拒绝')).toEqual({ kind: 'reject' })
  })

  it('accepts a decision code and rejects malformed ones', () => {
    expect(parseCommand('批准 a3f9')).toEqual({ kind: 'approve', code: 'a3f9' })
    expect(parseCommand('拒绝 K2M7')).toEqual({ kind: 'reject', code: 'k2m7' })
    expect(parseCommand('批准 abc')).toEqual({ kind: 'invalid', reason: 'bad-code' })
    expect(parseCommand('批准 oooo')).toEqual({ kind: 'invalid', reason: 'bad-code' })
  })

  it('parses task numbers', () => {
    expect(parseCommand('切 12')).toEqual({ kind: 'switch', number: 12 })
    expect(parseCommand('切 0')).toEqual({ kind: 'invalid', reason: 'bad-task-number' })
    expect(parseCommand('切 x')).toEqual({ kind: 'invalid', reason: 'bad-task-number' })
    expect(parseCommand('详情 2')).toEqual({ kind: 'detail', number: 2 })
  })

  it('parses answers with and without a code', () => {
    expect(parseCommand('回答 a3f9 详细')).toEqual({ kind: 'answer', code: 'a3f9', text: '详细' })
    expect(parseCommand('回答 详细')).toEqual({ kind: 'answer', text: '详细' })
    expect(parseCommand('回答')).toEqual({ kind: 'invalid', reason: 'answer-empty' })
  })

  it('keeps unknown text as a message and supports the escape prefix', () => {
    expect(parseCommand('你好')).toEqual({ kind: 'message', text: '你好' })
    expect(parseCommand('消息 批准 a3f9')).toEqual({ kind: 'message', text: '批准 a3f9' })
    expect(parseCommand('message 批准 a3f9')).toEqual({ kind: 'message', text: '批准 a3f9' })
  })

  it('rejects extra arguments on words that take none', () => {
    expect(parseCommand('任务 2')).toEqual({ kind: 'invalid', reason: 'unexpected-argument' })
    expect(parseCommand('暂停 现在')).toEqual({ kind: 'invalid', reason: 'unexpected-argument' })
    expect(parseCommand('')).toEqual({ kind: 'invalid', reason: 'empty' })
  })
})
