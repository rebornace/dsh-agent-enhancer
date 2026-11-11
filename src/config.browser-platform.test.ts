import { describe, expect, it } from 'vitest'
import {
  browserAgentBrowsersForPlatform,
  coerceBrowserAgentBrowserForPlatform,
  resolveBrowserAgentBrowser,
} from './config.ts'

describe('browser agent platform menus', () => {
  it('offers Safari instead of Edge on Mac', () => {
    expect(browserAgentBrowsersForPlatform('darwin')).toEqual(['auto', 'chrome', 'safari'])
    expect(browserAgentBrowsersForPlatform('win32')).toEqual(['auto', 'chrome', 'edge'])
    expect(browserAgentBrowsersForPlatform('linux')).toEqual(['auto', 'chrome'])
  })

  it('coerces Edge↔Safari across platforms', () => {
    expect(coerceBrowserAgentBrowserForPlatform('edge', 'darwin')).toBe('safari')
    expect(coerceBrowserAgentBrowserForPlatform('safari', 'win32')).toBe('edge')
    expect(coerceBrowserAgentBrowserForPlatform('chrome', 'darwin')).toBe('chrome')
    expect(coerceBrowserAgentBrowserForPlatform('auto', 'darwin')).toBe('auto')
  })

  it('accepts safari in resolveBrowserAgentBrowser', () => {
    expect(resolveBrowserAgentBrowser('safari')).toBe('safari')
    expect(resolveBrowserAgentBrowser('nope')).toBe('auto')
  })
})
