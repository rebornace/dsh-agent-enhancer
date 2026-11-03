import { describe, expect, it, vi } from 'vitest'
import { inspectContextCategory, pressureFromProjection } from '../src/host/context-inspect.ts'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

function event(partial: Partial<SessionEvent> & Pick<SessionEvent, 'type' | 'seq'>): SessionEvent {
  return {
    time: 0,
    data: {},
    ...partial,
  } as SessionEvent
}

function sessionWith(events: readonly SessionEvent[]): Session {
  return {
    snapshotEvents: () => events,
  } as Session
}

describe('inspectContextCategory', () => {
  it('lists system and message nodes from measure()', () => {
    const events = [
      event({
        type: 'system/message',
        seq: 1 as never,
        data: {
          turn: 0,
          step: 0,
          message: { role: 'system', content: [{ type: 'text', text: 'You are helpful.' }] },
        } as never,
      }),
      event({
        type: 'user/message',
        seq: 2 as never,
        data: {
          id: 'u1' as never,
          content: [{ type: 'text', text: 'Hello world' }],
          source: { kind: 'user' },
        } as never,
      }),
      event({
        type: 'assistant/message',
        seq: 3 as never,
        data: {
          message: {
            id: 'a1' as never,
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi there' }],
          },
        } as never,
      }),
    ]
    const tokenMeter = {
      measure: vi.fn(() => ({
        nodes: [
          { seq: 1, tokens: 10, heuristicTokens: 10 },
          { seq: 2, tokens: 8, heuristicTokens: 8 },
          { seq: 3, tokens: 7, heuristicTokens: 7 },
        ],
      })),
    } as unknown as TokenMeter

    const system = inspectContextCategory(sessionWith(events), 'system', tokenMeter)
    expect(system.items).toHaveLength(1)
    expect(system.items[0]?.title).toBe('System')
    expect(system.items[0]?.kind).toBe('system')
    expect(system.items[0]?.detail).toContain('helpful')
    expect(system.items[0]?.body).toContain('helpful')

    const messages = inspectContextCategory(sessionWith(events), 'messages', tokenMeter)
    expect(messages.items.map(item => item.title)).toEqual(['User', 'Assistant'])
    expect(messages.items.map(item => item.kind)).toEqual(['user', 'assistant'])
    expect(messages.totalTokens).toBe(15)
  })

  it('labels injected user messages and replace marks', () => {
    const events = [
      event({
        type: 'user/message',
        seq: 2 as never,
        surfaceOp: 'append',
        data: {
          id: 'u1' as never,
          content: [{ type: 'text', text: 'AGENTS.md rules' }],
          source: { kind: 'skill' },
        } as never,
      }),
      event({
        type: 'assistant/message',
        seq: 5 as never,
        surfaceOp: { op: 'replace', startSeq: 3 as never, endSeq: 4 as never },
        data: {
          message: {
            id: 'a1' as never,
            role: 'assistant',
            content: [{ type: 'text', text: 'summary after compact' }],
          },
        } as never,
      }),
    ]
    const tokenMeter = {
      measure: vi.fn(() => ({
        nodes: [
          { seq: 2, tokens: 12, heuristicTokens: 12 },
          { seq: 5, tokens: 20, heuristicTokens: 20 },
        ],
      })),
    } as unknown as TokenMeter

    const messages = inspectContextCategory(sessionWith(events), 'messages', tokenMeter)
    expect(messages.items[0]?.kind).toBe('inject')
    expect(messages.items[0]?.title).toContain('skill')
    expect(messages.items[1]?.replaced).toBe(true)
    expect(messages.events.some(mark => mark.kind === 'compact' || mark.kind === 'replace')).toBe(true)
  })

  it('splits a system message into one row per text block', () => {
    const events = [
      event({
        type: 'system/message',
        seq: 1 as never,
        data: {
          turn: 0,
          step: 0,
          message: {
            role: 'system',
            content: [
              { type: 'text', text: 'Harness rules.' },
              { type: 'text', text: 'You are a coding agent powered by deepseek-flash.' },
            ],
          },
        } as never,
      }),
    ]
    const tokenMeter = {
      measure: vi.fn(() => ({
        nodes: [{ seq: 1, tokens: 100, heuristicTokens: 100 }],
      })),
    } as unknown as TokenMeter

    const system = inspectContextCategory(sessionWith(events), 'system', tokenMeter)
    expect(system.items).toHaveLength(2)
    expect(system.items[0]?.title).toBe('Harness rules.')
    expect(system.items[1]?.body).toContain('coding agent')
    expect(system.items.reduce((sum, item) => sum + item.tokens, 0)).toBe(100)
    expect(system.items.every(item => item.tokens > 0)).toBe(true)
  })

  it('lists tools from the latest request header with schema body', () => {
    const events = [
      event({
        type: 'request/header',
        seq: 4 as never,
        data: {
          header: {
            tools: [
              {
                name: 'bash',
                description: 'Run a shell command',
                parameters: { type: 'object', properties: { command: { type: 'string' } } },
              },
              { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
            ],
          },
        } as never,
      }),
    ]
    const tokenMeter = { measure: vi.fn() } as unknown as TokenMeter
    const tools = inspectContextCategory(sessionWith(events), 'tools', tokenMeter)
    expect(tokenMeter.measure).not.toHaveBeenCalled()
    expect(tools.items.map(item => item.title)).toEqual(['bash', 'read_file'])
    expect(tools.items.every(item => item.tokens > 0 && item.kind === 'tools')).toBe(true)
    expect(tools.items[0]?.body).toContain('command')
  })

  it('maps projection pressure fields', () => {
    expect(pressureFromProjection({ projectedTokens: 1200, contextWindow: 128000 })).toEqual({
      projectedTokens: 1200,
      contextWindow: 128000,
    })
    expect(pressureFromProjection(undefined)).toEqual({})
  })
})
