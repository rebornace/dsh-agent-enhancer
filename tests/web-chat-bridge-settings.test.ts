import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, MODULES, resolveSettings } from '../src/config.ts'

describe('webChatBridge settings', () => {
  it('is a MODULE defaulting to on', () => {
    expect(MODULES).toContain('webChatBridge')
    expect(DEFAULT_SETTINGS.webChatBridgeEnabled).toBe(true)
    expect(resolveSettings(undefined).webChatBridgeEnabled).toBe(true)
    expect(resolveSettings({ webChatBridgeEnabled: false }).webChatBridgeEnabled).toBe(false)
  })
})
