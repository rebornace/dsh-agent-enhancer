import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ChatConversationViewNode, ChatSnapshot, FinalAssistantChatData, TurnTailChatData,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { latestCompletedTurn, sentPrompts } from '../src/client/dsh/conversation.ts'

function turnLocation(turn: number): TurnLocation {
  return {
    turn,
    start: undefined,
    end: undefined,
    status: 'closed',
    steps: [],
    data: {
      get: () => undefined,
      source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
    },
  }
}

function node(key: string, kind: string, data: unknown, turn = 1): ChatConversationViewNode {
  return {
    key,
    id: key,
    kind,
    target: 'chat',
    data,
    anchorSeq: 0,
    visibility: 'visible',
    location: { kind: 'turn', turn: turnLocation(turn) },
  }
}

function snapshot(nodes: readonly ChatConversationViewNode[]): ChatSnapshot {
  const byKey = new Map(nodes.map(value => [value.key, value]))
  const absent = { getSnapshot: () => undefined, subscribe: () => () => {} }
  const emptyList = { getSnapshot: () => [], subscribe: () => () => {} }
  return {
    order: nodes.map(value => value.key),
    nodes: {
      get: key => byKey.get(key),
      source: () => absent,
      bottomSource: () => ({ getSnapshot: () => false, subscribe: () => () => {} }),
      turnDataSource: () => emptyList,
      processSource: () => absent,
      values: () => nodes,
    },
    locations: { getTurn: () => [], getStep: () => [] },
    navigation: { items: () => [] },
    timeline: { turnOrder: [], turns: new Map() },
    legacy: { nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [] },
  }
}

function user(key: string, seq: number, content: readonly { type: 'text'; text: string }[], turn = 1) {
  return node(key, 'user', { kind: 'user', seq, time: seq, content, source: { kind: 'user' } }, turn)
}

function tail(key: string, turn: number, status: 'running' | 'settled' | 'interrupted', text: string) {
  const blocks = [
    { kind: 'reasoning', text: 'not the answer' },
    { kind: 'text', text },
  ] as const
  const closing: FinalAssistantChatData = {
    status,
    turn,
    step: 1,
    blocks,
    time: 20,
    finalNode: { kind: 'assistant', seq: 20, time: 20, turn, step: 1, blocks },
  }
  const data: TurnTailChatData = {
    turn,
    seq: 30,
    time: 30,
    closing,
    branchUnavailable: false,
  }
  return node(key, 'turn-tail', data, turn)
}

function session(running: boolean): SessionSnapshot {
  return {
    sessionId: 's1' as SessionId,
    pendingSubmissions: [],
    running,
    subagent: null,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: true,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    promptAttempted: true,
    awaitingFirstTurn: false,
  }
}

describe('sentPrompts', () => {
  it('keeps only ordered, non-empty user text and never treats steering as history', () => {
    const steering = node('steering', 'steering', {
      kind: 'steering', messageId: 'm2', seq: 2, time: 2,
      content: [{ type: 'text', text: 'not arrow history' }], source: { kind: 'user' },
    })
    const rollbackNotice = node('notice', 'user', {
      kind: 'user', seq: 4, time: 4,
      content: [{ type: 'text', text: 'Rolled back before turn 2' }],
      source: { kind: 'checkpoint-rollback', form: 'notice', summary: 'Rolled back before turn 2' },
    })
    const injected = node('inject', 'user', {
      kind: 'user', seq: 6, time: 6,
      content: [{ type: 'text', text: 'model-side inject' }],
      source: { kind: 'agent.inject' },
    })
    const chat = snapshot([
      user('u1', 1, [{ type: 'text', text: 'first ' }, { type: 'text', text: 'part' }]),
      steering,
      user('blank', 3, [{ type: 'text', text: '  \n' }]),
      rollbackNotice,
      node('assistant', 'assistant', { seq: 5 }),
      injected,
      user('u2', 7, [{ type: 'text', text: 'second' }]),
    ])

    expect(sentPrompts(chat)).toEqual([
      { seq: 1, text: 'first part' },
      { seq: 7, text: 'second' },
    ])
    expect(sentPrompts(undefined)).toEqual([])
  })
})

describe('latestCompletedTurn', () => {
  it('requires a settled turn-tail and an idle session, then projects only same-turn user and closing text', () => {
    const chat = snapshot([
      user('u1', 1, [{ type: 'text', text: 'older' }], 1),
      tail('tail-1', 1, 'settled', 'older answer'),
      user('u2a', 2, [{ type: 'text', text: 'new ' }], 2),
      node('steering-2', 'steering', {
        kind: 'steering', messageId: 'm3', seq: 3, time: 3,
        content: [{ type: 'text', text: 'exclude steering' }], source: { kind: 'user' },
      }, 2),
      user('u2b', 4, [{ type: 'text', text: 'prompt' }], 2),
      tail('tail-2', 2, 'settled', 'new answer'),
      user('other-turn', 5, [{ type: 'text', text: 'exclude later user' }], 3),
    ])

    expect(latestCompletedTurn(chat, session(false))).toEqual({
      turn: 2,
      prompt: 'new prompt',
      response: 'new answer',
    })
    expect(latestCompletedTurn(chat, session(true))).toBeNull()
    expect(latestCompletedTurn(snapshot([user('u1', 1, [{ type: 'text', text: 'no tail' }])]), session(false))).toBeNull()
    expect(latestCompletedTurn(snapshot([
      user('u1', 1, [{ type: 'text', text: 'interrupted' }]),
      tail('tail-1', 1, 'interrupted', 'partial'),
    ]), session(false))).toBeNull()
  })
})
