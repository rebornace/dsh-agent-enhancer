import { describe, expect, it } from 'vitest'
import {
  isLatestNonMarkerUserMessage,
  softPauseActionVisible,
} from '../src/client/soft-pause/visibility.ts'

const base = {
  enabled: true,
  isLatestUser: true,
  isMarker: false,
  running: false,
  engaged: false,
  treeRunning: false,
}

describe('softPauseActionVisible', () => {
  it('shows while this turn runs or the session is paused', () => {
    expect(softPauseActionVisible({ ...base, running: true })).toBe(true)
    expect(softPauseActionVisible({ ...base, engaged: true })).toBe(true)
  })

  it('stays reachable while only a subagent is working', () => {
    // The parent hands off in seconds; the child it spawned is the work left.
    expect(softPauseActionVisible({ ...base, treeRunning: true })).toBe(true)
  })

  it('hides on non-latest, marker, idle tree, or disabled', () => {
    expect(softPauseActionVisible({ ...base, running: true, isLatestUser: false })).toBe(false)
    expect(softPauseActionVisible({ ...base, running: true, isMarker: true })).toBe(false)
    expect(softPauseActionVisible({ ...base })).toBe(false)
    expect(softPauseActionVisible({ ...base, running: true, enabled: false })).toBe(false)
    expect(softPauseActionVisible({ ...base, treeRunning: true, enabled: false })).toBe(false)
  })
})

describe('isLatestNonMarkerUserMessage', () => {
  it('picks the last direct user prompt and skips markers', () => {
    const chat = {
      order: ['u1', 'a1', 'm1', 'u2'],
      nodes: new Map([
        ['u1', { kind: 'user', data: { id: '1', source: { kind: 'user' } } }],
        ['a1', { kind: 'assistant-step', data: {} }],
        ['m1', {
          kind: 'user',
          data: { id: 'checkpoint-rollback:2', source: { kind: 'checkpoint-rollback' } },
        }],
        ['u2', { kind: 'user', data: { id: '2', source: { kind: 'user' } } }],
      ]),
    }
    expect(isLatestNonMarkerUserMessage(chat, 'u2', '2', { kind: 'user' })).toBe(true)
    expect(isLatestNonMarkerUserMessage(chat, 'u1', '1', { kind: 'user' })).toBe(false)
    expect(isLatestNonMarkerUserMessage(
      chat,
      'm1',
      'checkpoint-rollback:2',
      { kind: 'checkpoint-rollback' },
    )).toBe(false)
  })
})
