import { describe, expect, it } from 'vitest'
import { browserAgentProfileDirFor, playwrightChannelOrder } from '../src/host/browser-agent/launch.ts'

describe('playwrightChannelOrder', () => {
  it('does not fall back when preference is explicit chrome or edge', () => {
    expect(playwrightChannelOrder('chrome', 'win32')).toEqual(['chrome'])
    expect(playwrightChannelOrder('edge', 'win32')).toEqual(['msedge'])
  })

  it('prefers Edge then Chrome on Windows auto', () => {
    expect(playwrightChannelOrder('auto', 'win32')).toEqual(['msedge', 'chrome'])
  })
})

describe('browserAgentProfileDirFor', () => {
  it('uses separate profile slots per preference', () => {
    const root = 'C:\\plugin-data'
    expect(browserAgentProfileDirFor(root, 'chrome')).toContain('profile-chrome')
    expect(browserAgentProfileDirFor(root, 'edge')).toContain('profile-edge')
    expect(browserAgentProfileDirFor(root, 'auto')).toContain('profile-auto')
    expect(browserAgentProfileDirFor(root, 'chrome')).not.toBe(browserAgentProfileDirFor(root, 'edge'))
  })
})
