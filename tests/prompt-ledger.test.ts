import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import { PromptHistoryLedger } from '../src/client/prompt/ledger.ts'
import {
  disposePromptLedger,
  invalidatePromptHistory,
  promptLedgerFor,
  subscribePromptLedgerInvalidation,
} from '../src/client/prompt/ledger-store.ts'
import { promptsFromSessionEntries } from '../src/client/rollback/prompt-entries.ts'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'

describe('PromptHistoryLedger', () => {
  it('keeps earlier prompts after the live chat shrinks', () => {
    const ledger = new PromptHistoryLedger()
    expect(ledger.observe([
      { seq: 1, text: 'first' },
      { seq: 5, text: 'second' },
    ])).toEqual([
      { seq: 1, text: 'first' },
      { seq: 5, text: 'second' },
    ])
    expect(ledger.observe([{ seq: 1, text: 'first' }])).toEqual([
      { seq: 1, text: 'first' },
      { seq: 5, text: 'second' },
    ])
  })

  it('keeps one entry per exact prompt text and prefers the newer seq', () => {
    const ledger = new PromptHistoryLedger()
    ledger.observe([
      { seq: 1, text: 'same prompt' },
      { seq: 2, text: 'other' },
    ])
    expect(ledger.observe([
      { seq: 8, text: 'same prompt' },
      { seq: 3, text: 'same prompt' },
    ])).toEqual([
      { seq: 2, text: 'other' },
      { seq: 8, text: 'same prompt' },
    ])
  })
})

describe('promptsFromSessionEntries', () => {
  it('keeps direct user text and ignores rollback notices / injects', () => {
    const entries = [
      {
        type: 'event',
        event: {
          seq: 1, time: 1, type: 'user/message', surfaceOp: 'append',
          data: {
            id: 'u1', role: 'user',
            content: [{ type: 'text', text: 'hello' }],
            source: { kind: 'user' },
          },
        },
      },
      {
        type: 'event',
        event: {
          seq: 2, time: 1, type: 'user/message', surfaceOp: 'append',
          data: {
            id: 'rb', role: 'user',
            content: [{ type: 'text', text: 'rolled back' }],
            source: { kind: 'checkpoint-rollback', form: 'notice', summary: 'x' },
          },
        },
      },
      {
        type: 'event',
        event: {
          seq: 3, time: 1, type: 'user/message', surfaceOp: 'append',
          data: {
            id: 'inj', role: 'user',
            content: [{ type: 'text', text: 'inject' }],
            source: { kind: 'agent.inject' },
          },
        },
      },
    ] as unknown as SessionEventLikeEntry[]
    expect(promptsFromSessionEntries(entries)).toEqual([{ seq: 1, text: 'hello' }])
  })
})

describe('prompt ledger store', () => {
  it('notifies invalidation listeners without disposing the ledger', () => {
    const sessionId = 'session-keep' as SessionId
    const listener = vi.fn()
    const stop = subscribePromptLedgerInvalidation(listener)
    promptLedgerFor(sessionId).observe([{ seq: 1, text: 'kept' }])
    invalidatePromptHistory(sessionId)
    expect(listener).toHaveBeenCalledWith(sessionId)
    expect(promptLedgerFor(sessionId).list()).toEqual([{ seq: 1, text: 'kept' }])
    stop()
    disposePromptLedger(sessionId)
  })
})
