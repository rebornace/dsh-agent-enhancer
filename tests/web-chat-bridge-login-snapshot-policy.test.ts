import { describe, expect, it } from 'vitest'
import { shouldPersistWebChatLoginCapture } from '../src/host/web-chat-bridge/login-snapshot-policy.ts'
import { WEB_CHAT_OFFICIAL_ORIGIN } from '../src/host/web-chat-bridge/login-snapshot-types.ts'
import type { WebChatLoginSnapshot } from '../src/host/web-chat-bridge/login-snapshot-types.ts'

function snap(
  localStorage: Record<string, string>,
  cookie = '',
): WebChatLoginSnapshot {
  return {
    version: 1,
    origin: WEB_CHAT_OFFICIAL_ORIGIN,
    localStorage,
    cookie,
    savedAt: '2026-11-09T00:00:00.000Z',
  }
}

describe('shouldPersistWebChatLoginCapture', () => {
  it('rejects null or empty captures', () => {
    expect(shouldPersistWebChatLoginCapture(null, null)).toBe(false)
    expect(shouldPersistWebChatLoginCapture(snap({ a: '1' }), null)).toBe(false)
    expect(shouldPersistWebChatLoginCapture(null, { localStorage: {}, cookie: '' })).toBe(false)
  })

  it('rejects weak capture when baseline has localStorage keys', () => {
    const baseline = snap({ token: 'x' })
    expect(shouldPersistWebChatLoginCapture(baseline, { localStorage: {}, cookie: '' })).toBe(false)
  })

  it('allows stronger or first-time captures', () => {
    expect(shouldPersistWebChatLoginCapture(null, { localStorage: { t: '1' }, cookie: '' })).toBe(true)
    expect(shouldPersistWebChatLoginCapture(snap({ a: '1' }), { localStorage: { a: '1', b: '2' }, cookie: '' })).toBe(true)
    expect(shouldPersistWebChatLoginCapture(snap({}), { localStorage: {}, cookie: 'sid=1' })).toBe(true)
  })
})
