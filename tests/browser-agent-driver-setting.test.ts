import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, resolveSettings } from '../src/config.ts'

describe('browser agent settings (Playwright-only)', () => {
  it('keeps browserAgent enabled off by default without a driver toggle', () => {
    expect(DEFAULT_SETTINGS.browserAgentEnabled).toBe(false)
    expect(resolveSettings(undefined).browserAgentEnabled).toBe(false)
    expect('browserAgentDriver' in DEFAULT_SETTINGS).toBe(false)
  })

  it('still resolves browser preference', () => {
    const settings = resolveSettings({
      browserAgentEnabled: true,
      browserAgentBrowser: 'edge',
    })
    expect(settings.browserAgentBrowser).toBe('edge')
    expect('browserAgentApproval' in settings).toBe(false)
    expect('browserAgentTrustedOrigins' in settings).toBe(false)
  })
})
