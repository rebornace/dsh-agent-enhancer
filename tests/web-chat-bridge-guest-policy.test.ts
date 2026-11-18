import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  WEB_CHAT_LOGIN_SNAPSHOT_VERSION,
  WEB_CHAT_OFFICIAL_ORIGIN,
} from '../src/host/web-chat-bridge/login-snapshot-types.ts'
import {
  buildWebChatGuestBootstrapSrc,
  buildWebChatGuestPreferencesScript,
  buildWebChatLoginRestoreScript,
  isAllowedWebChatGuestOpenUrl,
  WEB_CHAT_PREF_GUARD_KEY,
  WEB_CHAT_UNSAFE_ENV_WARN_KEY,
  stripElectronFromUserAgent,
  webChatGuestPreferencesAllowsReveal,
  webChatGuestPreferencesNeedsWait,
  webChatLoginRestoreApplied,
} from '../src/client/web-chat-bridge/guest-policy.ts'

const snapshot = {
  version: WEB_CHAT_LOGIN_SNAPSHOT_VERSION,
  origin: WEB_CHAT_OFFICIAL_ORIGIN,
  localStorage: { token: 'abc', userPassword: 'nope' },
  cookie: 'sid=1',
  savedAt: '2026-11-09T00:00:00.000Z',
} as const

describe('buildWebChatGuestBootstrapSrc', () => {
  it('embeds the lease in about:blank for Desktop will-attach-webview', () => {
    expect(buildWebChatGuestBootstrapSrc('lease-abc')).toBe('about:blank#lease-abc')
  })
})

describe('buildWebChatGuestPreferencesScript', () => {
  it('is a no-op off the official origin', () => {
    const result = runInNewContext(buildWebChatGuestPreferencesScript(), {
      location: { origin: 'about:blank', reload: vi.fn() },
      localStorage: { getItem: () => null, setItem: vi.fn() },
      sessionStorage: { getItem: () => null, setItem: vi.fn() },
    })
    expect(result).toBe('off-origin')
    expect(webChatGuestPreferencesNeedsWait(result)).toBe(false)
  })

  it('writes closeUnsafeEnvWarn in the site app-kit envelope and reloads once', () => {
    const stored = new Map<string, string>()
    const session = new Map<string, string>()
    const reload = vi.fn()
    const result = runInNewContext(buildWebChatGuestPreferencesScript(), {
      location: { origin: WEB_CHAT_OFFICIAL_ORIGIN, reload },
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => { stored.set(key, value) },
      },
      sessionStorage: {
        getItem: (key: string) => session.get(key) ?? null,
        setItem: (key: string, value: string) => { session.set(key, value) },
      },
    })
    expect(result).toBe('reloading')
    expect(webChatGuestPreferencesNeedsWait(result)).toBe(true)
    expect(reload).toHaveBeenCalledOnce()
    expect(session.get(WEB_CHAT_PREF_GUARD_KEY)).toBe('1')
    expect(JSON.parse(stored.get(WEB_CHAT_UNSAFE_ENV_WARN_KEY)!)).toEqual({
      value: true,
      __version: '0',
    })
  })

  it('returns ready when the dismiss flag is already true', () => {
    const reload = vi.fn()
    const result = runInNewContext(buildWebChatGuestPreferencesScript(), {
      location: { origin: WEB_CHAT_OFFICIAL_ORIGIN, reload },
      localStorage: {
        getItem: (key: string) => key === WEB_CHAT_UNSAFE_ENV_WARN_KEY
          ? JSON.stringify({ value: true, __version: '0' })
          : null,
        setItem: vi.fn(),
      },
      sessionStorage: { getItem: () => null, setItem: vi.fn() },
    })
    expect(result).toBe('ready')
    expect(webChatGuestPreferencesAllowsReveal(result)).toBe(true)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('stripElectronFromUserAgent', () => {
  it('removes the Electron token and leaves the rest intact', () => {
    expect(stripElectronFromUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Electron/28.0.0',
    )).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    )
  })
})

describe('isAllowedWebChatGuestOpenUrl', () => {
  it('allows https chat.deepseek.com', () => {
    expect(isAllowedWebChatGuestOpenUrl('https://chat.deepseek.com/a/chat/s/1?x=1')).toBe(true)
  })

  it('rejects arbitrary http(s), other DeepSeek hosts, and credentials', () => {
    expect(isAllowedWebChatGuestOpenUrl('http://chat.deepseek.com/')).toBe(false)
    expect(isAllowedWebChatGuestOpenUrl('https://evil.example/')).toBe(false)
    expect(isAllowedWebChatGuestOpenUrl('https://platform.deepseek.com/')).toBe(false)
    expect(isAllowedWebChatGuestOpenUrl('https://accounts.google.com/')).toBe(false)
    expect(isAllowedWebChatGuestOpenUrl('https://user:pw@chat.deepseek.com/')).toBe(false)
    expect(isAllowedWebChatGuestOpenUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedWebChatGuestOpenUrl('not a url')).toBe(false)
  })
})

describe('web chat login restore gate', () => {
  it('does not treat about:blank as a successful restore', () => {
    const setItem = vi.fn()
    const result = runInNewContext(buildWebChatLoginRestoreScript(snapshot), {
      location: { origin: 'about:blank' },
      window: { localStorage: { setItem } },
      document: { cookie: '' },
    })
    expect(webChatLoginRestoreApplied(result)).toBe(false)
    expect(setItem).not.toHaveBeenCalled()
  })

  it('reports applied only after writing on the official origin', () => {
    const stored = new Map<string, string>()
    const result = runInNewContext(buildWebChatLoginRestoreScript(snapshot), {
      location: { origin: WEB_CHAT_OFFICIAL_ORIGIN },
      window: {
        localStorage: {
          setItem: (key: string, value: string) => { stored.set(key, value) },
        },
      },
      document: { cookie: '' },
    })
    expect(webChatLoginRestoreApplied(result)).toBe(true)
    expect(stored.get('token')).toBe('abc')
    expect(stored.has('userPassword')).toBe(false)
    expect(webChatLoginRestoreApplied(undefined)).toBe(false)
    expect(webChatLoginRestoreApplied({ applied: true, origin: 'https://evil.example' })).toBe(false)
    expect(webChatLoginRestoreApplied({ applied: false, origin: WEB_CHAT_OFFICIAL_ORIGIN })).toBe(false)
  })

  it('does not report success when only password keys were skipped', () => {
    const result = runInNewContext(buildWebChatLoginRestoreScript({
      ...snapshot,
      localStorage: { userPassword: 'nope' },
      cookie: '',
    }), {
      location: { origin: WEB_CHAT_OFFICIAL_ORIGIN },
      window: { localStorage: { setItem: () => undefined } },
      document: { cookie: '' },
    })
    expect(webChatLoginRestoreApplied(result)).toBe(false)
  })
})
