import { describe, expect, it } from 'vitest'
import {
  isLatestNonMarkerUserMessage,
  softPauseActionVisible,
} from '../src/client/soft-pause/visibility.ts'

describe('softPauseActionVisible', () => {
  it('hides on non-latest, marker, idle-unpaused, or disabled', () => {
    expect(softPauseActionVisible({
      enabled: true,
      isLatestUser: true,
      isMarker: false,
      running: true,
      engaged: false,
    })).toBe(true)
    expect(softPauseActionVisible({
      enabled: true,
      isLatestUser: true,
      isMarker: false,
      running: false,
      engaged: true,
    })).toBe(true)
    expect(softPauseActionVisible({
      enabled: true,
      isLatestUser: false,
      isMarker: false,
      running: true,
      engaged: false,
    })).toBe(false)
    expect(softPauseActionVisible({
      enabled: true,
      isLatestUser: true,
      isMarker: true,
      running: true,
      engaged: false,
    })).toBe(false)
    expect(softPauseActionVisible({
      enabled: true,
      isLatestUser: true,
      isMarker: false,
      running: false,
      engaged: false,
    })).toBe(false)
    expect(softPauseActionVisible({
      enabled: false,
      isLatestUser: true,
      isMarker: false,
      running: true,
      engaged: false,
    })).toBe(false)
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
