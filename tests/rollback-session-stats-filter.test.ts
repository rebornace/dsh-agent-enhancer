import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it } from 'vitest'
import { installRollbackSessionStatsFilter } from '../src/client/rollback/session-stats-filter.ts'

const sessionId = 'session-stats-1' as SessionId
const disposers: Array<() => void> = []

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.()
})

function entry(
  seq: number,
  options: {
    type?: string
    surfaceOp?: 'append' | { op: 'replace', startSeq: number, endSeq: number }
    id?: string
    sourceKind?: string
    sourceEventSeqs?: number[]
    text?: string
    turn?: number
  } = {},
): SessionEventLikeEntry {
  const type = options.type ?? 'user/message'
  const surfaceOp = options.surfaceOp ?? 'append'
  const id = options.id ?? `msg-${seq}`
  const source = { kind: options.sourceKind ?? 'user' }
  const content = [{ type: 'text', text: options.text ?? `text-${seq}` }]
  if (type === 'user/message') {
    return {
      type: 'event',
      event: {
        seq, time: 1, type, surfaceOp,
        ...(options.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: options.sourceEventSeqs }),
        data: { id, role: 'user', content, source },
      },
    } as unknown as SessionEventLikeEntry
  }
  return {
    type: 'event',
    event: {
      seq, time: 1, type, surfaceOp,
      data: {
        ...(options.turn === undefined ? {} : { turn: options.turn, step: 1 }),
        message: {
          id, role: type.startsWith('assistant') ? 'assistant' : 'user', content, source,
        },
      },
    },
  } as unknown as SessionEventLikeEntry
}

function lifecycle(seq: number, type: string, data: Record<string, unknown>): SessionEventLikeEntry {
  return {
    type: 'event',
    event: { seq, time: 1, type, data },
  } as unknown as SessionEventLikeEntry
}

describe('installRollbackSessionStatsFilter', () => {
  it('always folds sessionStats turns/steps to the presented chat surface on first paint', () => {
    const entries: SessionEventLikeEntry[] = [
      lifecycle(1, 'turn/start', { turn: 1 }),
      lifecycle(2, 'step/start', { turn: 1, step: 1 }),
      entry(3, { text: 'only turn' }),
      entry(4, { type: 'assistant/message', turn: 1, text: 'answer' }),
      lifecycle(5, 'step/end', { turn: 1, step: 1 }),
      lifecycle(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    let stats: Record<string, number> = {
      // Host whole-log often disagrees with the visible chat window.
      turns: 7, steps: 42, llmMs: 1, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 9,
    }
    let statsSeq = 1
    const projections = {
      get: (key: string) => key === 'sessionStats' ? stats : undefined,
      seqOf: (key: string) => key === 'sessionStats' ? statsSeq : undefined,
      apply: (key: string, value: unknown, seq: number) => {
        if (key !== 'sessionStats') return
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
    expect(stats.turns).toBe(1)
    expect(stats.steps).toBe(1)
    expect(stats.decodeTokens).toBe(9)
  })

  it('overrides sessionStats turns and steps after a restore tip lands', () => {
    const entries: SessionEventLikeEntry[] = [
      lifecycle(1, 'turn/start', { turn: 1 }),
      lifecycle(2, 'step/start', { turn: 1, step: 1 }),
      entry(3, { text: 'keep' }),
      entry(4, { type: 'assistant/message', turn: 1, text: 'keep answer' }),
      lifecycle(5, 'step/end', { turn: 1, step: 1 }),
      lifecycle(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      lifecycle(7, 'turn/start', { turn: 2 }),
      lifecycle(8, 'step/start', { turn: 2, step: 1 }),
      entry(9, { text: 'rolled' }),
      entry(10, { type: 'assistant/message', turn: 2, text: 'rolled answer' }),
      lifecycle(11, 'step/end', { turn: 2, step: 1 }),
      lifecycle(12, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
      entry(13, {
        surfaceOp: { op: 'replace', startSeq: 7, endSeq: 12 },
        sourceEventSeqs: [9, 10],
        // Before-2 hides turn 2+ (keep-prefix is turn 1).
        id: 'dsh-agent-enhancer:rollback:2:journal-1',
        sourceKind: 'checkpoint-rollback',
      }),
    ]
    let stats: Record<string, number> = {
      turns: 10, steps: 113, llmMs: 1, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 1000, decodeTokens: 121,
    }
    let statsSeq = 1
    const eventListeners = new Set<() => void>()
    const statsListeners = new Set<() => void>()
    const projections = {
      get: (key: string) => key === 'sessionStats' ? stats : undefined,
      seqOf: (key: string) => key === 'sessionStats' ? statsSeq : undefined,
      apply: (key: string, value: unknown, seq: number) => {
        if (key !== 'sessionStats') return
        stats = value as Record<string, number>
        statsSeq = seq
        for (const listener of statsListeners) listener()
      },
      faceOf: (key: string) => ({
        subscribe: (listener: () => void) => {
          if (key === 'sessionStats') statsListeners.add(listener)
          return () => { statsListeners.delete(listener) }
        },
      }),
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
          subscribe: (listener: () => void) => {
            eventListeners.add(listener)
            return () => { eventListeners.delete(listener) }
          },
        },
        session: { projections },
      }),
      retainInfo: () => ({ subscribe: () => () => {} }),
    })

    disposers.push(installRollbackSessionStatsFilter(ctx))
    expect(stats.turns).toBe(1)
    expect(stats.steps).toBe(1)
    expect(stats.decodeTokens).toBe(121)
  })

  it('does not let an undo shell inflate turns/steps above the live surface', () => {
    const entries: SessionEventLikeEntry[] = [
      lifecycle(1, 'turn/start', { turn: 1 }),
      lifecycle(2, 'step/start', { turn: 1, step: 1 }),
      entry(3, { text: 'keep' }),
      entry(4, { type: 'assistant/message', turn: 1, text: 'keep answer' }),
      lifecycle(5, 'step/end', { turn: 1, step: 1 }),
      lifecycle(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      // Host undo shell (monotonic turn 3) — must not add a second turn/step.
      lifecycle(7, 'turn/start', { turn: 3 }),
      lifecycle(8, 'step/start', { turn: 3, step: 1 }),
      entry(9, { id: 'dsh-agent-enhancer:undo:j:0:3', text: 'keep' }),
      entry(10, {
        type: 'assistant/message',
        turn: 3,
        id: 'dsh-agent-enhancer:undo:j:1:4',
        text: 'keep answer',
      }),
      lifecycle(11, 'step/end', { turn: 3, step: 1 }),
      lifecycle(12, 'turn/end', { turn: 3, reason: { kind: 'completed' } }),
    ]
    let stats: Record<string, number> = {
      // Host whole-log already counted the undo shell as +1 turn/+1 step.
      turns: 2, steps: 2, llmMs: 1, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 10,
    }
    let statsSeq = 1
    const statsListeners = new Set<() => void>()
    const projections = {
      get: (key: string) => key === 'sessionStats' ? stats : undefined,
      seqOf: (key: string) => key === 'sessionStats' ? statsSeq : undefined,
      apply: (key: string, value: unknown, seq: number) => {
        if (key !== 'sessionStats') return
        stats = value as Record<string, number>
        statsSeq = seq
        for (const listener of statsListeners) listener()
      },
      faceOf: (key: string) => ({
        subscribe: (listener: () => void) => {
          if (key === 'sessionStats') statsListeners.add(listener)
          return () => { statsListeners.delete(listener) }
        },
      }),
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
    // Surface fold: original turn 1 only — undo shell dropped from the gauge.
    expect(stats.turns).toBe(1)
    expect(stats.steps).toBe(1)
  })

  it('does not publish a zeroed timing shell before Host sessionStats exists', () => {
    const entries: SessionEventLikeEntry[] = [
      lifecycle(1, 'turn/start', { turn: 1 }),
      lifecycle(2, 'step/start', { turn: 1, step: 1 }),
      entry(3, { text: 'only' }),
      lifecycle(4, 'step/end', { turn: 1, step: 1 }),
    ]
    let stats: Record<string, number> | undefined
    let statsSeq = 0
    const projections = {
      get: (key: string) => key === 'sessionStats' ? stats : undefined,
      seqOf: (key: string) => key === 'sessionStats' ? statsSeq : undefined,
      apply: (key: string, value: unknown, seq: number) => {
        if (key !== 'sessionStats') return
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
    // Wait for Host — inventing llmMs:0 would force ActivityPill into PlainPill.
    expect(stats).toBeUndefined()
  })

  it('keeps Host timing fields so ActivityPill stays a clickable DialogPill', () => {
    const entries: SessionEventLikeEntry[] = [
      lifecycle(1, 'turn/start', { turn: 1 }),
      lifecycle(2, 'step/start', { turn: 1, step: 1 }),
      entry(3, { text: 'only' }),
      lifecycle(4, 'step/end', { turn: 1, step: 1 }),
    ]
    let stats: Record<string, number> = {
      turns: 9,
      steps: 9,
      llmMs: 1200,
      toolMs: 80,
      ttftMs: 300,
      ttftSteps: 1,
      decodeMs: 400,
      decodeTokens: 50,
    }
    let statsSeq = 1
    const statsListeners = new Set<() => void>()
    const projections = {
      get: (key: string) => key === 'sessionStats' ? stats : undefined,
      seqOf: (key: string) => key === 'sessionStats' ? statsSeq : undefined,
      apply: (key: string, value: unknown, seq: number) => {
        if (key !== 'sessionStats') return
        stats = value as Record<string, number>
        statsSeq = seq
        for (const listener of statsListeners) listener()
      },
      faceOf: (key: string) => ({
        subscribe: (listener: () => void) => {
          if (key === 'sessionStats') statsListeners.add(listener)
          return () => { statsListeners.delete(listener) }
        },
      }),
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
    expect(stats.turns).toBe(1)
    expect(stats.steps).toBe(1)
    expect(stats.llmMs).toBe(1200)
    expect(stats.toolMs).toBe(80)
    expect(stats.ttftSteps).toBe(1)
    expect(stats.decodeTokens).toBe(50)
  })
})
