import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { describe, expect, it } from 'vitest'
import {
  activeRollbackUndoTip,
  activityStatsFromEntries,
  keepPrefixLoadThroughSeq,
  needsKeepPrefixHistory,
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
      id: 'dsh-agent-enhancer:rollback:1:journal-1',
      sourceKind: 'checkpoint-rollback',
      text: 'restored to turn 1',
    })
    const entries = [
      entry(1),
      entry(5, { text: 'second prompt' }),
      entry(8, { type: 'assistant/message', text: 'second answer' }),
      marker,
    ]

    const presented = presentRollbackTranscript(entries)
    expect(presented.map(item => item.type === 'event' ? item.event.seq : -1)).toEqual([1, 9])
    // Tip stays for keep-prefix bookkeeping; Chat hides ordinary context rows so it
    // does not appear as a conversation turn.
    expect(presented[1]).toMatchObject({
      type: 'event',
      event: {
        seq: 9,
        surfaceOp: 'append',
        data: { source: { kind: 'checkpoint-rollback' } },
      },
    })
  })

  it('after undo keeps originals hidden, drops the marker, and remaps copies onto the source turn', () => {
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
      assistantAt(7, 2, 'assistant-original', 'second answer'),
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
      assistantAt(13, 3, 'dsh-agent-enhancer:undo:restore-1:1:7', 'second answer', 3),
      lifecycle(14, 'step/end', { turn: 3, step: 1 }, 4),
      lifecycle(15, 'turn/end', { turn: 3, reason: { kind: 'completed' } }, 4),
    ]

    const presented = presentRollbackTranscript(entries)
    // Source messages stay shadowed; shell turn/start|end drops; shell step/start
    // dedupes against original seq 6; shell step/end is remapped onto turn 2
    // (original had no step/end) so activity + Chat both see a closed step.
    expect(presented.map(item => item.type === 'event' ? item.event.seq : -1)).toEqual([
      1, 4, 6, 8, 12, 13, 14,
    ])
    expect(presented).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: expect.objectContaining({
          seq: 12,
          surfaceOp: 'append',
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          seq: 13,
          data: expect.objectContaining({ turn: 2, step: 1 }),
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          seq: 14,
          type: 'step/end',
          data: { turn: 2, step: 1 },
        }),
      }),
    ]))
    expect(activityStatsFromEntries(entries)).toEqual({ turns: 1, steps: 1 })
  })

  it('preserves the window reference when no rollback markers exist', () => {
    const entries = [entry(1), entry(2)]
    expect(presentRollbackTranscript(entries)).toBe(entries)
  })

  it('shows only the latest live tip when older markers were never covered', () => {
    const tip3 = entry(20, {
      surfaceOp: { op: 'replace', startSeq: 10, endSeq: 18 },
      sourceEventSeqs: [10, 18],
      id: 'dsh-agent-enhancer:rollback:3:journal-a',
      sourceKind: 'checkpoint-rollback',
      text: 'rolled back before turn 3',
    })
    const tip5 = entry(40, {
      surfaceOp: { op: 'replace', startSeq: 30, endSeq: 38 },
      sourceEventSeqs: [30, 38],
      id: 'dsh-agent-enhancer:rollback:5:journal-b',
      sourceKind: 'checkpoint-rollback',
      text: 'rolled back before turn 5',
    })
    // tip3 stays markerStillActive because tip5's replace range does not cover seq 20.
    const presented = presentRollbackTranscript([
      entry(1, { text: 'keep' }),
      tip3,
      tip5,
    ])
    expect(presented.map(item => item.type === 'event' ? item.event.seq : -1)).toEqual([1, 40])
    expect(presented[1]).toMatchObject({
      event: {
        data: {
          id: 'dsh-agent-enhancer:rollback:5:journal-b',
          source: { kind: 'checkpoint-rollback' },
        },
      },
    })
  })

  it('hides the tip after append-only undo and remaps shell step chrome for Chat', () => {
    const marker = entry(9, {
      surfaceOp: { op: 'replace', startSeq: 5, endSeq: 7 },
      sourceEventSeqs: [5, 7],
      id: 'dsh-agent-enhancer:rollback:2:journal-1',
      sourceKind: 'checkpoint-rollback',
      text: 'rolled back before turn 2',
    })
    // Original step chrome was destroyed by tip filter replace — only the undo
    // shell remains. Remap its step/start|end so assistant-step can mount.
    const entries = [
      entry(1),
      marker,
      lifecycle(10, 'turn/start', { turn: 3 }, 3),
      lifecycle(11, 'step/start', { turn: 3, step: 1 }, 3),
      entry(12, {
        surfaceOp: 'append',
        id: 'dsh-agent-enhancer:undo:restore-1:0:5',
        text: 'second prompt',
      }),
      assistantAt(13, 3, 'dsh-agent-enhancer:undo:restore-1:1:7', 'second answer', 3),
      lifecycle(14, 'step/end', { turn: 3, step: 1 }, 4),
      lifecycle(15, 'turn/end', { turn: 3, reason: { kind: 'completed' } }, 4),
    ]
    const presented = presentRollbackTranscript(entries)
    expect(presented.map(item => item.type === 'event' ? item.event.seq : -1)).toEqual([
      1, 11, 12, 13, 14,
    ])
    expect(presented).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: expect.objectContaining({
          seq: 11,
          type: 'step/start',
          data: { turn: 3, step: 1 },
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          seq: 13,
          data: expect.objectContaining({ turn: 3, step: 1 }),
        }),
      }),
    ]))
    expect(activeRollbackUndoTip(presented)).toBeUndefined()
    expect(activityStatsFromEntries(entries)).toEqual({ turns: 1, steps: 1 })
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

  it('keeps earlier turns when the loaded window still contains the keep-prefix', () => {
    const marker = entry(20, {
      surfaceOp: { op: 'replace', startSeq: 5, endSeq: 18 },
      sourceEventSeqs: [6, 7, 13, 18],
      // Tip before-4 hides turn 4+ (keep-prefix is turns before 4).
      id: 'dsh-agent-enhancer:rollback:4:journal-1',
      sourceKind: 'checkpoint-rollback',
      text: 'rolled back before turn 4',
    })
    const presented = presentRollbackTranscript([
      lifecycle(1, 'turn/start', { turn: 1 }),
      entry(2, { text: 'turn 1 prompt' }),
      entry(3, { type: 'assistant/message', text: 'turn 1 answer' }),
      lifecycle(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      lifecycle(5, 'turn/start', { turn: 4 }),
      entry(6, { text: 'turn 4 prompt' }),
      entry(7, { type: 'assistant/message', text: 'turn 4 answer' }),
      lifecycle(8, 'turn/end', { turn: 4, reason: { kind: 'completed' } }),
      lifecycle(12, 'turn/start', { turn: 5 }),
      entry(13, { text: 'turn 5 prompt' }),
      entry(18, { type: 'assistant/message', text: 'turn 5 answer' }),
      marker,
    ])
    expect(presented.map(item => item.type === 'event' ? item.event.seq : -1)).toEqual([
      1, 2, 3, 4, 20,
    ])
    expect(needsKeepPrefixHistory(presented, true)).toBe(false)
  })

  it('requests older history when the filtered window is only the restore notice', () => {
    const marker = entry(90, {
      surfaceOp: { op: 'replace', startSeq: 50, endSeq: 88 },
      sourceEventSeqs: [50, 55, 88],
      id: 'dsh-agent-enhancer:rollback:5:journal-1',
      sourceKind: 'checkpoint-rollback',
      text: 'rolled back before turn 5',
    })
    const noticeOnly = presentRollbackTranscript([
      entry(50, { text: 'turn 5 prompt' }),
      entry(55, { type: 'assistant/message', text: 'turn 5 answer' }),
      marker,
    ])
    expect(noticeOnly.map(item => item.type === 'event' ? item.event.seq : -1)).toEqual([90])
    expect(keepPrefixLoadThroughSeq(noticeOnly)).toBe(49)
    expect(needsKeepPrefixHistory(noticeOnly, true)).toBe(true)
    expect(needsKeepPrefixHistory(noticeOnly, false)).toBe(false)
    expect(needsKeepPrefixHistory([
      entry(1, { text: 'keep prefix' }),
      ...noticeOnly,
    ], true)).toBe(false)
    expect(keepPrefixLoadThroughSeq([entry(9, {
      surfaceOp: { op: 'replace', startSeq: 5, endSeq: 8 },
      id: 'dsh-agent-enhancer:rollback:2:journal-1',
      sourceKind: 'checkpoint-rollback',
    })])).toBeUndefined()
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
    // Tip rollback:2 → cut before turn 2 → hide from turn 2.
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
    // Before-1 hides turn-1 chrome; shadowed messages stay hidden; fresh turns after tip stay.
    expect(presented.map(item => item.type === 'event' ? item.event.seq : -1)).toEqual([
      9, 10, 11, 12, 13,
    ])
    expect(presented.map(item => item.type === 'event' ? item.event.type : '')).toEqual([
      'user/message', 'turn/start', 'user/message', 'assistant/message', 'turn/end',
    ])
  })

  it('hides rolled-back turn boundaries so Completed timing and the turn rail clear', () => {
    // Restore-to-1 hides turn 2+ (inclusive tip keeps turn 1).
    const marker = entry(9, {
      surfaceOp: { op: 'replace', startSeq: 5, endSeq: 6 },
      sourceEventSeqs: [5, 6],
      id: 'dsh-agent-enhancer:rollback:1:journal-1',
      sourceKind: 'checkpoint-rollback',
      text: 'restored to turn 1',
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

  it('strips the undo shell and remaps copies onto the source turn so Chat can render', () => {
    const tip = entry(10, {
      surfaceOp: { op: 'replace', startSeq: 6, endSeq: 7 },
      sourceEventSeqs: [6, 7],
      id: 'dsh-agent-enhancer:rollback:2:journal-1',
      sourceKind: 'checkpoint-rollback',
      text: 'rolled back before turn 2',
    })
    const presented = presentRollbackTranscript([
      entry(1),
      lifecycle(4, 'turn/start', { turn: 2 }, 2),
      lifecycle(5, 'step/start', { turn: 2, step: 1 }, 2),
      entry(6, { text: 'original prompt' }),
      assistantAt(7, 2, 'assistant-original', 'original answer', 2),
      lifecycle(8, 'step/end', { turn: 2, step: 1 }, 2),
      lifecycle(9, 'turn/end', { turn: 2, reason: { kind: 'completed' } }, 2),
      tip,
      // Host undo shell (monotonic turn 5) re-copies seq 6/7 after the tip.
      lifecycle(11, 'turn/start', { turn: 5 }, 3),
      lifecycle(12, 'step/start', { turn: 5, step: 1 }, 3),
      entry(13, {
        id: 'dsh-agent-enhancer:undo:restore-1:0:6',
        text: 'restored prompt',
        surfaceOp: { op: 'replace', startSeq: 10, endSeq: 10 },
        sourceEventSeqs: [6, 10],
      }),
      assistantAt(14, 5, 'dsh-agent-enhancer:undo:restore-1:1:7', 'restored answer', 3),
      lifecycle(15, 'step/end', { turn: 5, step: 1 }, 3),
      lifecycle(16, 'turn/end', { turn: 5, reason: { kind: 'completed' } }, 4),
      lifecycle(17, 'turn/start', { turn: 5 }, 5),
      entry(18, { text: 'fresh prompt' }),
      assistantAt(19, 5, 'assistant-2', 'fresh answer', 5),
      lifecycle(20, 'turn/end', { turn: 5, reason: { kind: 'completed' } }, 6),
    ])

    // Originals 6/7 stay shadowed; tip is superseded; undo shell chrome dropped.
    expect(presented.map(item => item.type === 'event' ? item.event.seq : -1)).toEqual([
      1, 4, 5, 8, 9, 13, 14, 17, 18, 19, 20,
    ])
    const turnStarts = presented.flatMap(item => {
      if (item.type !== 'event' || item.event.type !== 'turn/start') return []
      return [item.event.data.turn]
    })
    // Undo shell turn/start dropped; original turn 2 chrome + fresh turn 5 remain.
    expect(turnStarts).toEqual([2, 5])
    expect(presented).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: expect.objectContaining({
          seq: 14,
          data: expect.objectContaining({ turn: 2, step: 1 }),
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          seq: 19,
          data: expect.objectContaining({ turn: 5 }),
        }),
      }),
    ]))
  })

  it('counts activity pill turns and steps from closed step/end on the presented surface', () => {
    // Before-2 hides turn 2+ so the pill stays on the keep-prefix (turn 1).
    const marker = entry(11, {
      surfaceOp: { op: 'replace', startSeq: 6, endSeq: 10 },
      sourceEventSeqs: [7, 9],
      id: 'dsh-agent-enhancer:rollback:2:journal-1',
      sourceKind: 'checkpoint-rollback',
    })
    expect(activityStatsFromEntries([
      lifecycle(1, 'turn/start', { turn: 1 }),
      lifecycle(2, 'step/start', { turn: 1, step: 1 }),
      entry(3, { text: 'first' }),
      assistantAt(4, 1, 'a1', 'answer 1'),
      lifecycle(5, 'step/end', { turn: 1, step: 1 }),
      lifecycle(6, 'turn/start', { turn: 2 }),
      lifecycle(7, 'step/start', { turn: 2, step: 1 }),
      entry(8, { text: 'second' }),
      assistantAt(9, 2, 'a2', 'answer 2'),
      lifecycle(10, 'step/end', { turn: 2, step: 1 }, 2),
      marker,
    ])).toEqual({ turns: 1, steps: 1 })
  })

  it('omits undo-shell turns from the turn rail outline', async () => {
    const { filterTurnOutline, undoShellRangesFromEntries } = await import('../src/client/rollback/transcript.ts')
    const entries = [
      entry(1),
      lifecycle(10, 'turn/start', { turn: 3 }),
      entry(11, { id: 'dsh-agent-enhancer:undo:j:0:5', text: 'restored' }),
      lifecycle(12, 'turn/end', { turn: 3, reason: { kind: 'completed' } }),
      lifecycle(14, 'turn/start', { turn: 3 }, 5),
      entry(15, { text: 'fresh prompt' }),
      lifecycle(16, 'turn/end', { turn: 3, reason: { kind: 'completed' } }, 6),
    ]
    const ranges = undoShellRangesFromEntries(entries)
    expect(ranges).toEqual([{ turn: 3, startSeq: 10, endSeq: 12 }])
    expect(filterTurnOutline([
      { turn: 1, seq: 1, prompt: 'a', response: 'b' },
      { turn: 3, seq: 10, prompt: 'restored', response: '' },
      { turn: 3, seq: 14, prompt: 'fresh prompt', response: '' },
    ], undefined, undefined, ranges)).toEqual([
      { turn: 1, seq: 1, prompt: 'a', response: 'b' },
      { turn: 3, seq: 14, prompt: 'fresh prompt', response: '' },
    ])
  })
})
