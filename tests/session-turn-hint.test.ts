import { describe, expect, it } from 'vitest'
import { sessionTurnHint } from '../src/host/auto-route/session-turn-hint.ts'

describe('sessionTurnHint', () => {
  it('returns undefined without snapshotEvents', () => {
    expect(sessionTurnHint({})).toBeUndefined()
    expect(sessionTurnHint(undefined)).toBeUndefined()
  })

  it('reads the latest user message and tool-heavy signal', () => {
    const hint = sessionTurnHint({
      snapshotEvents: () => [
        { type: 'user/message', data: { content: [{ type: 'text', text: 'first' }] } },
        { type: 'tool/result' },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'second' }] } },
      ],
    })
    expect(hint).toEqual({ text: 'second', toolHeavy: true })
  })
})
