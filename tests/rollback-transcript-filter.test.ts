import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installRollbackTranscriptFilter } from '../src/client/rollback/transcript-filter.ts'

const sessionId = 'session-filter-1' as SessionId
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

describe('installRollbackTranscriptFilter', () => {
  it('pages through the keep-prefix cut once when the loaded window collapses to the restore notice', async () => {
    const marker = entry(90, {
      surfaceOp: { op: 'replace', startSeq: 50, endSeq: 88 },
      sourceEventSeqs: [50, 88],
      id: 'dsh-agent-enhancer:rollback:5:journal-1',
      sourceKind: 'checkpoint-rollback',
      text: 'rolled back before turn 5',
    })
    let entries: readonly SessionEventLikeEntry[] = [
      entry(50, { text: 'turn 5 prompt' }),
      entry(88, { type: 'assistant/message', text: 'turn 5 answer' }),
      marker,
    ]
    let hasMore = true
    const listeners = new Set<() => void>()
    const loadThrough = vi.fn(async (seq: number) => {
      expect(seq).toBe(49)
      await Promise.resolve()
      entries = [
        entry(1, { text: 'turn 1 prompt' }),
        entry(2, { type: 'assistant/message', text: 'turn 1 answer' }),
        marker,
      ]
      hasMore = false
      for (const listener of listeners) listener()
    })
    const replace = vi.fn((next: readonly SessionEventLikeEntry[], nextHasMore?: boolean) => {
      entries = next
      if (nextHasMore !== undefined) hasMore = nextHasMore
      for (const listener of listeners) listener()
    })
    const eventSource = {
      getSnapshot: () => ({ entries, hasMore, revision: 1 }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      replace,
    }
    const session = {
      loadThrough,
      hasMore: true,
      loadingOlder: false,
      baseSeq: 50,
      openState: 'open' as const,
    }
    const ctx = new Context()
    ctx.provide('sessions', {
      list: {
        getSnapshot: () => ({ ids: [sessionId] }),
        subscribe: () => () => {},
      },
      binding: () => ({ eventSource, session }),
      retainInfo: () => ({ subscribe: () => () => {} }),
    })

    disposers.push(installRollbackTranscriptFilter(ctx))
    await vi.waitFor(() => {
      expect(loadThrough).toHaveBeenCalledWith(49)
    })
    await vi.waitFor(() => {
      expect(entries.map(item => item.type === 'event' ? item.event.seq : -1)).toEqual([1, 2, 90])
    })
    expect(loadThrough).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalled()
  })

  it('does not latch a failed attempt while the session is still opening', async () => {
    const marker = entry(90, {
      surfaceOp: { op: 'replace', startSeq: 50, endSeq: 88 },
      sourceEventSeqs: [50, 88],
      id: 'dsh-agent-enhancer:rollback:5:journal-1',
      sourceKind: 'checkpoint-rollback',
    })
    let entries: readonly SessionEventLikeEntry[] = [marker]
    let hasMore = true
    const eventListeners = new Set<() => void>()
    const sessionListeners = new Set<() => void>()
    const loadThrough = vi.fn(async (seq: number) => {
      await Promise.resolve()
      entries = [
        entry(1, { text: 'turn 1 prompt' }),
        entry(2, { type: 'assistant/message', text: 'turn 1 answer' }),
        marker,
      ]
      hasMore = false
      for (const listener of eventListeners) listener()
    })
    const session = {
      loadThrough,
      hasMore: false,
      loadingOlder: false,
      baseSeq: 0,
      openState: 'loading' as string,
      subscribe: (listener: () => void) => {
        sessionListeners.add(listener)
        return () => { sessionListeners.delete(listener) }
      },
    }
    const eventSource = {
      getSnapshot: () => ({ entries, hasMore, revision: 1 }),
      subscribe: (listener: () => void) => {
        eventListeners.add(listener)
        return () => { eventListeners.delete(listener) }
      },
      replace: (next: readonly SessionEventLikeEntry[], nextHasMore?: boolean) => {
        entries = next
        if (nextHasMore !== undefined) hasMore = nextHasMore
        for (const listener of eventListeners) listener()
      },
    }
    const ctx = new Context()
    ctx.provide('sessions', {
      list: {
        getSnapshot: () => ({ ids: [sessionId] }),
        subscribe: () => () => {},
      },
      binding: () => ({ eventSource, session }),
      retainInfo: () => ({ subscribe: () => () => {} }),
    })

    disposers.push(installRollbackTranscriptFilter(ctx))
    expect(loadThrough).not.toHaveBeenCalled()

    // Session finishes opening — snapshot subscribe must retry keep-prefix load.
    session.openState = 'open'
    session.hasMore = true
    session.baseSeq = 90
    for (const listener of sessionListeners) listener()

    await vi.waitFor(() => {
      expect(loadThrough).toHaveBeenCalledWith(49)
    })
    await vi.waitFor(() => {
      expect(entries.map(item => item.type === 'event' ? item.event.seq : -1)).toEqual([1, 2, 90])
    })
  })

  it('does not re-enter loadThrough when the first call is a no-op', async () => {
    const marker = entry(90, {
      surfaceOp: { op: 'replace', startSeq: 50, endSeq: 88 },
      sourceEventSeqs: [50, 88],
      id: 'dsh-agent-enhancer:rollback:5:journal-1',
      sourceKind: 'checkpoint-rollback',
    })
    let entries: readonly SessionEventLikeEntry[] = [marker]
    const listeners = new Set<() => void>()
    const loadThrough = vi.fn(async () => {
      for (const listener of listeners) listener()
    })
    const eventSource = {
      getSnapshot: () => ({ entries, hasMore: true, revision: 1 }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      replace: (next: readonly SessionEventLikeEntry[]) => {
        entries = next
        for (const listener of listeners) listener()
      },
    }
    const ctx = new Context()
    ctx.provide('sessions', {
      list: {
        getSnapshot: () => ({ ids: [sessionId] }),
        subscribe: () => () => {},
      },
      binding: () => ({
        eventSource,
        session: {
          loadThrough,
          hasMore: true,
          loadingOlder: false,
          baseSeq: 90,
          openState: 'open',
        },
      }),
      retainInfo: () => ({ subscribe: () => () => {} }),
    })

    disposers.push(installRollbackTranscriptFilter(ctx))
    await vi.waitFor(() => {
      expect(loadThrough).toHaveBeenCalledTimes(1)
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(loadThrough).toHaveBeenCalledTimes(1)
  })
})
