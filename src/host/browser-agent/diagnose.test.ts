import { describe, expect, it } from 'vitest'
import { diagnose, usableBrowsers } from './diagnose.ts'
import type { BrowserAvailability } from './diagnose.ts'

const all: BrowserAvailability = { chrome: true, edge: true, safari: true }
const none: BrowserAvailability = { chrome: false, edge: false, safari: false }

const base = {
  enabled: true,
  ready: false,
  preference: 'auto' as const,
  platform: 'win32',
  lastError: null,
  availability: all,
}

describe('diagnose', () => {
  it('sends the user to the feature switch when the agent is off', () => {
    const result = diagnose({ ...base, enabled: false })
    expect(result.code).toBe('disabled')
    expect(result.nextStep).toContain('设置')
  })

  it('reports ready without advice', () => {
    expect(diagnose({ ...base, ready: true }).code).toBe('ok')
  })

  it('turns the WebKit token into the install command', () => {
    const result = diagnose({
      ...base,
      preference: 'safari',
      platform: 'darwin',
      lastError: 'WEBKIT_MISSING: Playwright WebKit is not installed. Run: npx playwright install webkit',
    })
    expect(result.code).toBe('webkit_missing')
    expect(result.nextStep).toContain('npx playwright install webkit')
    expect(result.detail).toContain('WEBKIT_MISSING')
  })

  it('names the missing browser when the platform has nothing usable', () => {
    const result = diagnose({ ...base, availability: none })
    expect(result.code).toBe('browser_missing')
    expect(result.nextStep).toContain('Chrome')
  })

  it('explains a Safari choice on a machine without Safari', () => {
    const result = diagnose({
      ...base,
      platform: 'darwin',
      preference: 'safari',
      availability: { chrome: true, edge: false, safari: false },
    })
    expect(result.code).toBe('browser_missing')
    expect(result.nextStep).toContain('WebKit')
  })

  it('recognises a profile still held by a leftover window', () => {
    const result = diagnose({
      ...base,
      lastError: 'ProcessSingleton: failed to create a ProcessSingleton for your profile directory',
    })
    expect(result.code).toBe('profile_locked')
    expect(result.nextStep).toContain('Close it')
  })

  it('falls back to launch_failed for anything else Playwright reports', () => {
    const result = diagnose({ ...base, lastError: 'Target page, context or browser has been closed' })
    expect(result.code).toBe('launch_failed')
    expect(result.detail).toContain('Target page')
  })

  it('treats a clean cold start as idle, not broken', () => {
    const result = diagnose(base)
    expect(result.code).toBe('idle')
    expect(result.nextStep).toContain('browser_navigate')
  })
})

describe('usableBrowsers', () => {
  it('follows the platform auto order', () => {
    expect(usableBrowsers({ preference: 'auto', platform: 'win32', availability: all })).toEqual(['edge', 'chrome'])
    expect(usableBrowsers({ preference: 'auto', platform: 'darwin', availability: all })).toEqual(['safari', 'chrome'])
    expect(usableBrowsers({ preference: 'auto', platform: 'linux', availability: all })).toEqual(['chrome'])
  })

  it('drops browsers that are not installed', () => {
    expect(usableBrowsers({
      preference: 'auto',
      platform: 'win32',
      availability: { chrome: true, edge: false, safari: false },
    })).toEqual(['chrome'])
  })
})
