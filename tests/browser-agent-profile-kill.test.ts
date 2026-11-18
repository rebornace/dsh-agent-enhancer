import { describe, expect, it } from 'vitest'
import { commandLineReferencesProfile } from '../src/host/browser-agent/launch.ts'

describe('commandLineReferencesProfile', () => {
  it('matches Windows backslash command lines against forward-slash needles', () => {
    const profile = 'C:/Users/tester/.dsh/profiles/desktop/plugin-data/dsh-agent-enhancer/browser-agent/profile-chrome'
    const cmd = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir=C:\\Users\\tester\\.dsh\\profiles\\desktop\\plugin-data\\dsh-agent-enhancer\\browser-agent\\profile-chrome --no-first-run'
    expect(commandLineReferencesProfile(cmd, profile)).toBe(true)
  })

  it('matches when both sides use backslashes', () => {
    const profile = 'C:\\Users\\tester\\.dsh\\profiles\\desktop\\plugin-data\\dsh-agent-enhancer\\browser-agent\\profile-edge'
    const cmd = 'msedge.exe --user-data-dir=C:\\Users\\tester\\.dsh\\profiles\\desktop\\plugin-data\\dsh-agent-enhancer\\browser-agent\\profile-edge'
    expect(commandLineReferencesProfile(cmd, profile)).toBe(true)
  })

  it('does not match a different profile slot', () => {
    const profile = 'C:/plugin-data/browser-agent/profile-chrome'
    const cmd = 'chrome.exe --user-data-dir=C:\\plugin-data\\browser-agent\\profile-edge'
    expect(commandLineReferencesProfile(cmd, profile)).toBe(false)
  })
})
