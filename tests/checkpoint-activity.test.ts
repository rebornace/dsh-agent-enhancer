import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import {
  isUndoShellCheckpoint,
  liveActivityStats,
  undoShellRanges,
} from '../src/host/checkpoint/activity.ts'
import { ROLLBACK_PREFIX, UNDO_PREFIX } from '../src/identity.ts'

function ev<T extends SessionEvent['type']>(
  type: T,
  seq: number,
  data: Extract<SessionEvent, { type: T }>['data'],
  extras: Partial<SessionEvent> = {},
): SessionEvent {
  return { type, seq: SessionSeq(seq), time: seq, data, ...extras } as SessionEvent
}

describe('undoShellRanges / isUndoShellCheckpoint', () => {
  it('keys undo shells by seq range so reused turn ids stay distinct', () => {
    const events: SessionEvent[] = [
      ev('turn/start', 10, { turn: 3 }),
      ev('user/message', 11, {
        id: `${UNDO_PREFIX}j:0:7` as never,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'restored' }],
      }, { surfaceOp: 'append' }),
      ev('assistant/message', 12, {
        turn: 3,
        step: 1,
        message: {
          id: `${UNDO_PREFIX}j:1:8` as never,
          role: 'assistant',
          content: [{ type: 'text', text: 'reply' }],
          source: { kind: 'model', provider: 't', model: 't' },
        },
        stream: [],
      }, { surfaceOp: 'append' }),
      ev('turn/end', 13, { turn: 3, reason: { kind: 'completed' } }),
      ev('turn/start', 20, { turn: 3 }),
      ev('user/message', 21, {
        id: 'user-real' as never,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'fresh' }],
      }, { surfaceOp: 'append' }),
      ev('turn/end', 22, { turn: 3, reason: { kind: 'completed' } }),
    ]

    const ranges = undoShellRanges(events)
    expect(ranges).toEqual([{ turn: 3, startSeq: 10, endSeq: 13 }])
    expect(isUndoShellCheckpoint(9, ranges)).toBe(true)
    expect(isUndoShellCheckpoint(19, ranges)).toBe(false)
  })
})

describe('liveActivityStats', () => {
  it('counts closed step/end and ignores steps behind the live tip', () => {
    const tipId = `${ROLLBACK_PREFIX}2:j` as never
    const events: SessionEvent[] = [
      ev('step/end', 2, { turn: 1, step: 1 }),
      ev('step/end', 4, { turn: 2, step: 1 }),
      ev('user/message', 5, {
        id: tipId, role: 'user',
        source: { kind: 'checkpoint-rollback', form: 'notice', summary: 'tip' },
        content: [{ type: 'text', text: 'rolled back' }],
      }, { surfaceOp: { op: 'replace', startSeq: SessionSeq(3), endSeq: SessionSeq(4) } }),
    ]

    const stats = liveActivityStats(events, {
      // Tip rollback:2 → hide from turn 2 (before-N cut).
      hideTurnsFrom: 2,
      continueAfterSeq: 5,
      checkpointCount: 2,
      liveCheckpointCount: 1,
    })
    expect(stats).toEqual({
      turns: 1,
      steps: 1,
      checkpoints: 2,
      liveCheckpoints: 1,
    })
  })
})
