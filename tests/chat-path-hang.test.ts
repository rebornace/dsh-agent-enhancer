import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { installSessionCutFilter, syncCutCache } from '../src/host/checkpoint/cut-live.ts'
import { SessionCutStore } from '../src/host/checkpoint/cut-store.ts'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map(async dir => {
    await rm(dir, { recursive: true, force: true })
  }))
})

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`))
    }, ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

describe('ordinary chat path hang safety', () => {
  it('agent/pre-step cut warm completes quickly when no cut exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cut-hang-'))
    temps.push(root)
    const store = new SessionCutStore(join(root, 'cuts'))
    const cache = new Map()
    const sessionId = 'session-hang-1' as SessionId
    const session = {
      id: sessionId,
      deriveMessages: () => [{ role: 'user', content: 'hi' }],
    }
    const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
    const ctx = {
      on(event: string, handler: (...args: unknown[]) => unknown) {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
        return () => {
          const next = (listeners.get(event) ?? []).filter(item => item !== handler)
          listeners.set(event, next)
        }
      },
      agents: {
        get: () => ({ session }),
      },
    }
    const dispose = installSessionCutFilter(ctx as never, { store, cache })
    try {
      const preStep = listeners.get('agent/pre-step')?.[0]
      expect(preStep).toBeTypeOf('function')
      const next = vi.fn(async () => 'ok')
      const result = await withTimeout(
        Promise.resolve(preStep!({ agent: { session } }, next)),
        2_000,
        'agent/pre-step warm',
      )
      expect(result).toBe('ok')
      expect(next).toHaveBeenCalledOnce()
      expect(cache.get(sessionId)).toBeNull()
      // deriveMessages stays uncut when no cut is stored
      expect(session.deriveMessages()).toEqual([{ role: 'user', content: 'hi' }])
    } finally {
      dispose()
    }
  })

  it('deriveMessages with an active cut returns promptly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cut-hang2-'))
    temps.push(root)
    const store = new SessionCutStore(join(root, 'cuts'))
    const cache = new Map()
    const sessionId = 'session-hang-2' as SessionId
    syncCutCache(cache, sessionId, {
      hideTurnsFrom: 2,
      cutSeq: 10,
      restoredAtSeq: 20,
      draftPrompt: 'draft',
      scope: 'conversation',
      previous: null,
    })
    const kept = { seq: 5, type: 'user/message', data: {} }
    const withdrawn = { seq: 15, type: 'user/message', data: {} }
    const session = {
      id: sessionId,
      surface: { nodes: [5, 15] },
      snapshotEvents: () => [kept, withdrawn],
      deriveEventMessage: (event: { seq: number }) => ({
        role: 'user' as const,
        content: `msg-${event.seq}`,
      }),
      deriveMessages() {
        return [{ role: 'user' as const, content: 'native' }]
      },
    }
    const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
    const ctx = {
      on(event: string, handler: (...args: unknown[]) => unknown) {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
        return () => undefined
      },
      agents: { get: () => ({ session }) },
    }
    const dispose = installSessionCutFilter(ctx as never, { store, cache })
    try {
      const preStep = listeners.get('agent/pre-step')![0]!
      await withTimeout(Promise.resolve(preStep({ agent: { session } }, async () => undefined)), 2_000, 'pre-step')
      const messages = await withTimeout(
        Promise.resolve(session.deriveMessages()),
        2_000,
        'deriveMessages under cut',
      )
      expect(messages).toEqual([{ role: 'user', content: 'msg-5' }])
    } finally {
      dispose()
    }
  })

})
