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
  return { type: 'event', event: event as SessionEventLikeEntry['event'] }
}

describe('presentRollbackTranscript', () => {
  it('hides shadowed append-origin messages and shows the active rollback marker as an append tip', () => {
    const marker = entry(9, {
      surfaceOp: { op: 'replace', startSeq: 5, endSeq: 8 },
      sourceEventSeqs: [5, 8],
      id: 'dsh-composer-enhancer:rollback:2:journal-1',
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
    const oldStart = {
      type: 'event' as const,
      event: {
        seq: 4, time: 1, type: 'turn/start',
        data: { turn: 2 },
      } as SessionEventLikeEntry['event'],
    }
    const oldEnd = {
      type: 'event' as const,
      event: {
        seq: 8, time: 2, type: 'turn/end',
        data: { turn: 2, reason: { kind: 'completed' } },
      } as SessionEventLikeEntry['event'],
    }
    const marker = entry(9, {
      surfaceOp: { op: 'replace', startSeq: 5, endSeq: 7 },
      sourceEventSeqs: [5, 7],
      id: 'dsh-composer-enhancer:rollback:2:journal-1',
      sourceKind: 'checkpoint-rollback',
    })
    // Host opens the next monotonic turn (not the rolled-back id) with a step shell.
    const undoStart = {
      type: 'event' as const,
      event: {
        seq: 10, time: 3, type: 'turn/start',
        data: { turn: 3 },
      } as SessionEventLikeEntry['event'],
    }
    const undoStepStart = {
      type: 'event' as const,
      event: {
        seq: 11, time: 3, type: 'step/start',
        data: { turn: 3, step: 1 },
      } as SessionEventLikeEntry['event'],
    }
    const undoUser = entry(12, {
      surfaceOp: { op: 'replace', startSeq: 9, endSeq: 9 },
      sourceEventSeqs: [9, 5],
      id: 'dsh-composer-enhancer:undo:restore-1:0:5',
      text: 'second prompt',
    })
    const undoAssistant = entry(13, {
      type: 'assistant/message',
      surfaceOp: 'append',
      id: 'dsh-composer-enhancer:undo:restore-1:1:7',
      text: 'second answer',
    })
    const undoStepEnd = {
      type: 'event' as const,
      event: {
        seq: 14, time: 4, type: 'step/end',
        data: { turn: 3, step: 1 },
      } as SessionEventLikeEntry['event'],
    }
    const undoEnd = {
      type: 'event' as const,
      event: {
        seq: 15, time: 4, type: 'turn/end',
        data: { turn: 3, reason: { kind: 'completed' } },
      } as SessionEventLikeEntry['event'],
    }
    const oldStep = {
      type: 'event' as const,
      event: {
        seq: 6, time: 1, type: 'step/start',
        data: { turn: 2, step: 1 },
      } as SessionEventLikeEntry['event'],
    }
    const entries = [
      entry(1),
      oldStart,
      entry(5, { text: 'second prompt' }),
      oldStep,
      entry(7, { type: 'assistant/message', text: 'second answer' }),
      oldEnd,
      marker,
      undoStart,
      undoStepStart,
      undoUser,
      undoAssistant,
      undoStepEnd,
      undoEnd,
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
      id: 'dsh-composer-enhancer:rollback:2:journal-1',
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
      id: 'dsh-composer-enhancer:rollback:2:journal-1',
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
    const oldStart = {
      type: 'event' as const,
      event: {
        seq: 4, time: 1, type: 'turn/start',
        data: { turn: 1 },
      } as SessionEventLikeEntry['event'],
    }
    const marker = entry(9, {
      surfaceOp: { op: 'replace', startSeq: 4, endSeq: 8 },
      sourceEventSeqs: [5, 8],
      id: 'dsh-composer-enhancer:rollback:1:journal-1',
      sourceKind: 'checkpoint-rollback',
    })
    const turnStart = {
      type: 'event' as const,
      event: {
        seq: 10, time: 2, type: 'turn/start',
        data: { turn: 1 },
      } as SessionEventLikeEntry['event'],
    }
    const prompt = entry(11, { text: 'fresh prompt after empty restore' })
    const reply = entry(12, { type: 'assistant/message', text: 'fresh answer' })
    const turnEnd = {
      type: 'event' as const,
      event: {
        seq: 13, time: 3, type: 'turn/end',
        data: { turn: 1, reason: { kind: 'completed' } },
      } as SessionEventLikeEntry['event'],
    }
    const presented = presentRollbackTranscript([
      oldStart,
      entry(5, { text: 'old first prompt' }),
      entry(8, { type: 'assistant/message', text: 'old answer' }),
      marker,
      turnStart,
      prompt,
      reply,
      turnEnd,
    ])
    expect(presented.map(item => item.type === 'event' ? item.event.seq : -1)).toEqual([
      9, 10, 11, 12, 13,
    ])
    expect(presented.map(item => item.type === 'event' ? item.event.type : '')).toEqual([
      'user/message', 'turn/start', 'user/message', 'assistant/message', 'turn/end',
    ])
  })

  it('hides rolled-back turn boundaries so Completed timing and the turn rail clear', () => {
    const turnStart = {
      type: 'event' as const,
      event: {
        seq: 4, time: 1, type: 'turn/start',
        data: { turn: 2 },
      } as SessionEventLikeEntry['event'],
    }
    const turnEnd = {
      type: 'event' as const,
      event: {
        seq: 7, time: 5_000, type: 'turn/end',
        data: { turn: 2, reason: { kind: 'completed' } },
      } as SessionEventLikeEntry['event'],
    }
    const marker = entry(9, {
      surfaceOp: { op: 'replace', startSeq: 5, endSeq: 6 },
      sourceEventSeqs: [5, 6],
      id: 'dsh-composer-enhancer:rollback:2:journal-1',
      sourceKind: 'checkpoint-rollback',
      text: 'rolled back before turn 2',
    })
    const entries = [
      entry(1),
      turnStart,
      entry(5, { text: 'second prompt' }),
      entry(6, { type: 'assistant/message', text: 'second answer' }),
      turnEnd,
      marker,
    ]

    const presented = presentRollbackTranscript(entries)
    expect(presented.map(item => item.type === 'event' ? item.event.seq : -1)).toEqual([1, 9])
    expect(presented.map(item => item.type === 'event' ? item.event.type : '')).toEqual([
      'user/message', 'user/message',
    ])
  })

  it('renumbers an undo shell when a later prompt reuses its turn id', () => {
    const undoStart = {
      type: 'event' as const,
      event: {
        seq: 10, time: 3, type: 'turn/start',
        data: { turn: 2 },
      } as SessionEventLikeEntry['event'],
    }
    const undoAssistant = {
      type: 'event' as const,
      event: {
        seq: 12, time: 3, type: 'assistant/message', surfaceOp: 'append',
        data: {
          turn: 2,
          step: 1,
          message: {
            id: 'dsh-composer-enhancer:undo:restore-1:1:7',
            role: 'assistant',
            content: [{ type: 'text', text: 'restored answer' }],
            source: { kind: 'model' },
          },
        },
      } as SessionEventLikeEntry['event'],
    }
    const undoEnd = {
      type: 'event' as const,
      event: {
        seq: 13, time: 4, type: 'turn/end',
        data: { turn: 2, reason: { kind: 'completed' } },
      } as SessionEventLikeEntry['event'],
    }
    const reuseStart = {
      type: 'event' as const,
      event: {
        seq: 14, time: 5, type: 'turn/start',
        data: { turn: 2 },
      } as SessionEventLikeEntry['event'],
    }
    const freshAssistant = {
      type: 'event' as const,
      event: {
        seq: 16, time: 5, type: 'assistant/message', surfaceOp: 'append',
        data: {
          turn: 2,
          step: 1,
          message: {
            id: 'assistant-2',
            role: 'assistant',
            content: [{ type: 'text', text: 'fresh answer' }],
            source: { kind: 'model' },
          },
        },
      } as SessionEventLikeEntry['event'],
    }
    const reuseEnd = {
      type: 'event' as const,
      event: {
        seq: 17, time: 6, type: 'turn/end',
        data: { turn: 2, reason: { kind: 'completed' } },
      } as SessionEventLikeEntry['event'],
    }

    const presented = presentRollbackTranscript([
      entry(1),
      undoStart,
      entry(11, { id: 'dsh-composer-enhancer:undo:restore-1:0:5', text: 'restored prompt' }),
      undoAssistant,
      undoEnd,
      reuseStart,
      entry(15, { text: 'fresh prompt' }),
      freshAssistant,
      reuseEnd,
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
