import { describe, expect, it } from 'vitest'
import {
  WEB_CHAT_CLIPBOARD_CONSOLE_PREFIX,
  WEB_CHAT_RESTORE_GUARD_KEY,
  buildWebChatClipboardBridgeScript,
  buildWebChatLoginRestoreScript,
  webChatLoginRestoreApplied,
  webChatLoginRestoreNeedsWait,
} from './guest-policy.ts'
import { WEB_CHAT_OFFICIAL_ORIGIN } from '../../host/web-chat-bridge/login-snapshot-types.ts'

describe('buildWebChatClipboardBridgeScript', () => {
  it('includes the console bridge marker', () => {
    const script = buildWebChatClipboardBridgeScript()
    expect(script).toContain(WEB_CHAT_CLIPBOARD_CONSOLE_PREFIX)
    expect(script).toContain('writeText')
  })
})

describe('web chat login restore', () => {
  it('reloads once after writing so the SPA boots with restored storage', () => {
    const script = buildWebChatLoginRestoreScript({
      version: 1,
      origin: WEB_CHAT_OFFICIAL_ORIGIN,
      localStorage: { userToken: '{"value":"x","__version":"0"}' },
      cookie: '',
      savedAt: '2026-11-09T00:00:00.000Z',
    })
    expect(script).toContain(WEB_CHAT_RESTORE_GUARD_KEY)
    expect(script).toContain('location.reload()')
    expect(script).toContain('reloading: true')
  })

  it('detects applied / reloading results', () => {
    expect(webChatLoginRestoreApplied({
      applied: true,
      reloading: true,
      origin: WEB_CHAT_OFFICIAL_ORIGIN,
    })).toBe(true)
    expect(webChatLoginRestoreNeedsWait({
      applied: true,
      reloading: true,
      origin: WEB_CHAT_OFFICIAL_ORIGIN,
    })).toBe(true)
    expect(webChatLoginRestoreNeedsWait({
      applied: true,
      reloading: false,
      origin: WEB_CHAT_OFFICIAL_ORIGIN,
    })).toBe(false)
  })
})
