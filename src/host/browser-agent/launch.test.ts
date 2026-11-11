import { describe, expect, it } from 'vitest'
import {
  browserAgentProfileDirFor,
  browserExecutableCandidates,
  browserKindFromPlaywrightChannel,
  playwrightChannelOrder,
  playwrightChannelSatisfiesPreference,
  resolveBrowserExecutable,
} from './launch.ts'

describe('browserExecutableCandidates (darwin)', () => {
  it('includes system and user Applications for Chrome', () => {
    const paths = browserExecutableCandidates('chrome', 'darwin', { HOME: '/Users/demo' })
    expect(paths).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    expect(paths).toContain(
      '/Users/demo/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    )
    expect(paths).toContain('/Applications/Chromium.app/Contents/MacOS/Chromium')
  })

  it('includes system Safari for Mac', () => {
    const paths = browserExecutableCandidates('safari', 'darwin', { HOME: '/Users/demo' })
    expect(paths).toContain('/Applications/Safari.app/Contents/MacOS/Safari')
    expect(paths).toContain('/Users/demo/Applications/Safari.app/Contents/MacOS/Safari')
  })
})

describe('resolveBrowserExecutable (darwin)', () => {
  it('auto prefers Safari when present', () => {
    const resolved = resolveBrowserExecutable('auto', {
      platform: 'darwin',
      env: { HOME: '/Users/demo' },
      exists: (path) => path === '/Applications/Safari.app/Contents/MacOS/Safari',
      where: () => null,
    })
    expect(resolved).toEqual({
      kind: 'safari',
      executable: '/Applications/Safari.app/Contents/MacOS/Safari',
    })
  })

  it('auto falls back to Chrome when Safari is missing', () => {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    const resolved = resolveBrowserExecutable('auto', {
      platform: 'darwin',
      env: { HOME: '/Users/demo' },
      exists: (path) => path === chrome,
      where: () => null,
    })
    expect(resolved).toEqual({ kind: 'chrome', executable: chrome })
  })

  it('resolves explicit Safari preference', () => {
    const safari = '/Applications/Safari.app/Contents/MacOS/Safari'
    const resolved = resolveBrowserExecutable('safari', {
      platform: 'darwin',
      env: { HOME: '/Users/demo' },
      exists: (path) => path === safari,
      where: () => null,
    })
    expect(resolved).toEqual({ kind: 'safari', executable: safari })
  })
})

describe('playwrightChannelOrder', () => {
  it('uses WebKit then Chrome on Mac auto', () => {
    expect(playwrightChannelOrder('auto', 'darwin')).toEqual(['webkit', 'chrome'])
  })

  it('uses Edge then Chrome on Windows auto', () => {
    expect(playwrightChannelOrder('auto', 'win32')).toEqual(['msedge', 'chrome'])
  })

  it('locks Safari to WebKit only', () => {
    expect(playwrightChannelOrder('safari', 'darwin')).toEqual(['webkit'])
  })

  it('maps channels back to browser kinds', () => {
    expect(browserKindFromPlaywrightChannel('webkit')).toBe('safari')
    expect(browserKindFromPlaywrightChannel('msedge')).toBe('edge')
    expect(browserKindFromPlaywrightChannel('chrome')).toBe('chrome')
  })

  it('keeps auto Chrome fallback as a satisfying channel (no relaunch flap)', () => {
    expect(playwrightChannelSatisfiesPreference('chrome', 'auto', 'darwin')).toBe(true)
    expect(playwrightChannelSatisfiesPreference('webkit', 'auto', 'darwin')).toBe(true)
    expect(playwrightChannelSatisfiesPreference('msedge', 'auto', 'darwin')).toBe(false)
    expect(playwrightChannelSatisfiesPreference('chrome', 'safari', 'darwin')).toBe(false)
  })

  it('isolates auto channel profiles so WebKit and Chrome do not share user-data', () => {
    expect(browserAgentProfileDirFor('/data', 'auto', 'webkit')).toBe(
      '/data/browser-agent/profile-auto-webkit',
    )
    expect(browserAgentProfileDirFor('/data', 'auto', 'chrome')).toBe(
      '/data/browser-agent/profile-auto-chrome',
    )
    expect(browserAgentProfileDirFor('/data', 'safari')).toBe(
      '/data/browser-agent/profile-safari',
    )
  })
})
