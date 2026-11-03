import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { describe, expect, it } from 'vitest'
import {
  activeRollbackUndoTip,
  presentRollbackTranscript,
} from '../src/client/rollback/transcript.ts'

function entry(
  seq: number,
  options: {
    type?: string
    surfaceOp?: 'append' | { op: 'replace', startSeq: number, endSeq: number }
    id?: string
    sourceKind?: string
    sourceEventSeqs?: number[]
    text?: string
  } = {},
): SessionEventLikeEntry {
  const type = options.type ?? 'user/message'
  const surfaceOp = options.surfaceOp ?? 'append'
  const id = options.id ?? `msg-${seq}`
  const source = { kind: options.sourceKind ?? 'user' }
  const content = [{ type: 'text', text: options.text ?? `text-${seq}` }]
  const event = type === 'user/message'
    ? {
      seq, time: 1, type, surfaceOp,
      ...(options.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: options.sourceEventSeqs }),
      data: { id, role: 'user', content, source },
    }
    : {
      seq, time: 1, type, surfaceOp,
      ...(options.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: options.sourceEventSeqs }),
      data: {
        message: { id, role: type.startsWith('assistant') ? 'assistant' : 'user', content, source },
      },
    }
  return { type: 'event', event } as unknown as SessionEventLikeEntry
}

function lifecycle(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  time = 1,
): SessionEventLikeEntry {
  return {
    type: 'event',
    event: { seq, time, type, data },
  } as unknown as SessionEventLikeEntry
}

function assistantAt(
  seq: number,
  turn: number,
  id: string,
  text: string,
  time = 1,
): SessionEventLikeEntry {
  return {
    type: 'event',
    event: {
      seq,
      time,
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn,
        step: 1,
        message: {
          id,
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model' },
        },
      },
    },
  } as unknown as SessionEventLikeEntry
}

describe('presentRollbackTranscript', () => {
  it('hides shadowed append-origin messages and shows the active rollback marker as an append tip', () => {
    const marker = entry(9, {
      surfaceOp: { op: 'replace', startSeq: 5, endSeq: 8 },
      sourceEventSeqs: [5, 8],
      id: 'dsh-agent-enhancer:rollback:2:journal-1',
      sourceKind: 'checkpoint-rollback',
      text: 'rolled back before turn 2',
    })
    const entries = [
      entry(1),
      entry(5, { text: 'second prompt' }),
      entry(8, { type: 'assistant/message', text: 'second answer' }),
      marker,
    ]

    const presented = presentRollbackTranscript(entries)
    expect(presented.map(item => item.type === 'event' ? item.event.seq : -1)).toEqual([1, 9])
    expect(presented[1]).toMatchObject({
      type: 'event',
      event: {
        seq: 9,
        surfaceOp: 'append',
        data: { source: { kind: 'checkpoint-rollback' } },
      },
    })
  })

  it('after undo keeps originals hidden, drops the marker, and shows undo copies inside a fresh turn shell', () => {
    const marker = entry(9, {
      surfaceOp: { op: 'replace', startSeq: 5, endSeq: 7 },
      sourceEventSeqs: [5, 7],
      id: 'dsh-agent-enhancer:rollback:2:journal-1',
      sourceKind: 'checkpoint-rollback',
    })
    // Host opens the next monotonic turn (not the rolled-back id) with a step shell.
    const entries = [
      entry(1),
      lifecycle(4, 'turn/start', { turn: 2 }),
      entry(5, { text: 'second prompt' }),
      lifecycle(6, 'step/start', { turn: 2, step: 1 }),
      entry(7, { type: 'assistant/message', text: 'second answer' }),
      lifecycle(8, 'turn/end', { turn: 2, reason: { kind: 'completed' } }, 2),
      marker,
      lifecycle(10, 'turn/start', { turn: 3 }, 3),
      lifecycle(11, 'step/start', { turn: 3, step: 1 }, 3),
      entry(12, {
        surfaceOp: { op: 'replace', startSeq: 9, endSeq: 9 },
        sourceEventSeqs: [9, 5],
        id: 'dsh-agent-enhancer:undo:restore-1:0:5',
        text: 'second prompt',
      }),
      entry(13, {
        type: 'assistant/message',
        surfaceOp: 'append',
        id: 'dsh-agent-enhancer:undo:restore-1:1:7',
        text: 'second answer',
      }),
      lifecycle(14, 'step/end', { turn: 3, step: 1 }, 4),
      lifecycle(15, 'turn/end', { turn: 3, reason: { kind: 'completed' } }, 4),
    ]

    const presented = presentRollbackTranscript(entries)
    expect(presented.map(item => item.type === 'event' ? item.event.seq : -1)).toEqual([
      1, 10, 11, 12, 13, 14, 15,
    ])
    expect(presented.map(item => item.type === 'event' ? item.event.type : '')).toEqual([
      'user/message', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(presented[3]).toMatchObject({
      type: 'event',
      event: { seq: 12, surfaceOp: 'append' },
    })
  })

  it('preserves the window reference when no rollback markers exist', () => {
    const entries = [entry(1), entry(2)]
    expect(presentRollbackTranscript(entries)).toBe(entries)
  })

  it('exposes an undo tip only while the active marker remains the log tip', () => {
    const marker = entry(9, {
      surfaceOp: { op: 'replace', startSeq: 5, endSeq: 8 },
      sourceEventSeqs: [5, 8],
      id: 'dsh-agent-enhancer:rollback:2:journal-1',
      sourceKind: 'checkpoint-rollback',
    })
    expect(activeRollbackUndoTip([entry(1), marker])).toEqual({ turn: 2 })
    expect(activeRollbackUndoTip([
      entry(1),
      marker,
      entry(10, { text: 'continued after restore' }),
    ])).toBeUndefined()
  })

  it('filters turnOutline entries at and after the active rollback turn', async () => {
    const { activeRollbackHideTurnsFrom, filterTurnOutline } = await import('../src/client/rollback/transcript.ts')
    const marker = entry(9, {
      surfaceOp: { op: 'replace', startSeq: 5, endSeq: 6 },
      sourceEventSeqs: [5, 6],
      id: 'dsh-agent-enhancer:rollback:2:journal-1',
      sourceKind: 'checkpoint-rollback',
    })
    const hideFrom = activeRollbackHideTurnsFrom([entry(1), marker])
    expect(hideFrom).toBe(2)
    const outline = [
      { turn: 1, seq: 1, prompt: 'a', response: 'b' },
      { turn: 2, seq: 4, prompt: 'c', response: 'd' },
      { turn: 3, seq: 9, prompt: 'e', response: 'f' },
    ]
    expect(filterTurnOutline(outline, hideFrom)).toEqual([
      { turn: 1, seq: 1, prompt: 'a', response: 'b' },
    ])
    expect(filterTurnOutline(outline, hideFrom, 9)).toEqual([
      { turn: 1, seq: 1, prompt: 'a', response: 'b' },
    ])
    expect(filterTurnOutline([
      ...outline,
      { turn: 2, seq: 12, prompt: 'fresh', response: 'reply' },
    ], hideFrom, 9)).toEqual([
      { turn: 1, seq: 1, prompt: 'a', response: 'b' },
      { turn: 2, seq: 12, prompt: 'fresh', response: 'reply' },
    ])
  })

  it('keeps new turns after the restore tip even when they reuse a rolled-back turn number', () => {
    const marker = entry(9, {
      surfaceOp: { op: 'replace', startSeq: 4, endSeq: 8 },
      sourceEventSeqs: [5, 8],
      id: 'dsh-agent-enhancer:rollback:1:journal-1',
      sourceKind: 'checkpoint-rollback',
    })
    const presented = presentRollbackTranscript([
      lifecycle(4, 'turn/start', { turn: 1 }),
      entry(5, { text: 'old first prompt' }),
      entry(8, { type: 'assistant/message', text: 'old answer' }),
      marker,
      lifecycle(10, 'turn/start', { turn: 1 }, 2),
      entry(11, { text: 'fresh prompt after empty restore' }),
      entry(12, { type: 'assistant/message', text: 'fresh answer' }),
      lifecycle(13, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
    ])
    expect(presented.map(item => item.type === 'event' ? item.event.seq : -1)).toEqual([
      9, 10, 11, 12, 13,
    ])
    expect(presented.map(item => item.type === 'event' ? item.event.type : '')).toEqual([
      'user/message', 'turn/start', 'user/message', 'assistant/message', 'turn/end',
    ])
  })

  it('hides rolled-back turn boundaries so Completed timing and the turn rail clear', () => {
    const marker = entry(9, {
      surfaceOp: { op: 'replace', startSeq: 5, endSeq: 6 },
      sourceEventSeqs: [5, 6],
      id: 'dsh-agent-enhancer:rollback:2:journal-1',
      sourceKind: 'checkpoint-rollback',
      text: 'rolled back before turn 2',
    })
    const entries = [
      entry(1),
      lifecycle(4, 'turn/start', { turn: 2 }),
      entry(5, { text: 'second prompt' }),
      entry(6, { type: 'assistant/message', text: 'second answer' }),
      lifecycle(7, 'turn/end', { turn: 2, reason: { kind: 'completed' } }, 5_000),
      marker,
    ]

    const presented = presentRollbackTranscript(entries)
    expect(presented.map(item => item.type === 'event' ? item.event.seq : -1)).toEqual([1, 9])
    expect(presented.map(item => item.type === 'event' ? item.event.type : '')).toEqual([
      'user/message', 'user/message',
    ])
  })

  it('renumbers an undo shell when a later prompt reuses its turn id', () => {
    const presented = presentRollbackTranscript([
      entry(1),
      lifecycle(10, 'turn/start', { turn: 2 }, 3),
      entry(11, { id: 'dsh-agent-enhancer:undo:restore-1:0:5', text: 'restored prompt' }),
      assistantAt(12, 2, 'dsh-agent-enhancer:undo:restore-1:1:7', 'restored answer', 3),
      lifecycle(13, 'turn/end', { turn: 2, reason: { kind: 'completed' } }, 4),
      lifecycle(14, 'turn/start', { turn: 2 }, 5),
      entry(15, { text: 'fresh prompt' }),
      assistantAt(16, 2, 'assistant-2', 'fresh answer', 5),
      lifecycle(17, 'turn/end', { turn: 2, reason: { kind: 'completed' } }, 6),
    ])

    const turnStarts = presented.flatMap(item => {
      if (item.type !== 'event' || item.event.type !== 'turn/start') return []
      return [item.event.data.turn]
    })
    expect(turnStarts).toEqual([1, 2])
    expect(presented).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: expect.objectContaining({
          seq: 12,
          data: expect.objectContaining({ turn: 1 }),
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          seq: 16,
          data: expect.objectContaining({ turn: 2 }),
        }),
      }),
    ]))
  })
})
