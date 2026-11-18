import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installRollbackSessionStatsFilter,
  withActivityCounts,
} from '../src/client/rollback/session-stats-filter.ts'

const sessionId = 'session-stats-1' as SessionId
const disposers: Array<() => void> = []

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.()
})

function entry(seq: number, text = `text-${seq}`): SessionEventLikeEntry {
  return {
    type: 'event',
    event: {
      seq, time: 1, type: 'user/message', surfaceOp: 'append',
      data: {
        id: `msg-${seq}`, role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      },
    },
  } as unknown as SessionEventLikeEntry
}

describe('withActivityCounts', () => {
  it('folds turns/steps without touching timing fields', () => {
    const next = withActivityCounts(
      { turns: 7, steps: 42, llmMs: 1200, decodeTokens: 9 },
      { turns: 1, steps: 1 },
    )
    expect(next).toEqual({ turns: 1, steps: 1, llmMs: 1200, decodeTokens: 9 })
  })

  it('returns the same object when counts already match', () => {
    const base = { turns: 2, steps: 3, llmMs: 1 }
    expect(withActivityCounts(base, { turns: 2, steps: 3 })).toBe(base)
  })
})

describe('installRollbackSessionStatsFilter', () => {
  it('does not overwrite Host sessionStats turns/steps (official ledger)', () => {
    const entries: SessionEventLikeEntry[] = [entry(1, 'only turn')]
    let stats: Record<string, number> = {
      turns: 7, steps: 42, llmMs: 1, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 9,
    }
    let statsSeq = 1
    let applyCount = 0
    const projections = {
      get: (key: string) => key === 'sessionStats' ? stats : undefined,
      seqOf: (key: string) => key === 'sessionStats' ? statsSeq : undefined,
      apply: (key: string, value: unknown, seq: number) => {
        if (key !== 'sessionStats') return
        applyCount += 1
        stats = value as Record<string, number>
        statsSeq = seq
      },
      faceOf: () => ({ subscribe: () => () => {} }),
    }
    const ctx = new Context()
    ctx.provide('sessions', {
      list: {
        getSnapshot: () => ({ ids: [sessionId] }),
        subscribe: () => () => {},
      },
      binding: () => ({
        eventSource: {
          getSnapshot: () => ({ entries, hasMore: false, revision: 1 }),
          subscribe: () => () => {},
        },
        session: { projections },
      }),
      retainInfo: () => ({ subscribe: () => () => {} }),
    })

    disposers.push(installRollbackSessionStatsFilter(ctx))
    expect(applyCount).toBe(0)
    expect(stats.turns).toBe(7)
    expect(stats.steps).toBe(42)
    expect(stats.decodeTokens).toBe(9)
  })
})
