import { describe, expect, it } from 'vitest'
import {
  BROWSER_AGENT_IDLE_CLOSE,
  browserAgentIdleCloseMs,
  resolveBrowserAgentIdleClose,
} from './config.ts'

describe('resolveBrowserAgentIdleClose', () => {
  it('keeps the four configured values', () => {
    for (const value of BROWSER_AGENT_IDLE_CLOSE) {
      expect(resolveBrowserAgentIdleClose(value)).toBe(value)
    }
  })

  it('reads the legacy boolean stored by 0.3.14', () => {
    expect(resolveBrowserAgentIdleClose(true)).toBe('10m')
    expect(resolveBrowserAgentIdleClose(false)).toBe('never')
  })

  it('falls back to 10 minutes for anything unrecognised', () => {
    expect(resolveBrowserAgentIdleClose(undefined)).toBe('10m')
    expect(resolveBrowserAgentIdleClose('2h')).toBe('10m')
    expect(resolveBrowserAgentIdleClose(42)).toBe('10m')
  })
})

describe('browserAgentIdleCloseMs', () => {
  it('maps each option to a sweep age, with never switching it off', () => {
    expect(browserAgentIdleCloseMs('10m')).toBe(600_000)
    expect(browserAgentIdleCloseMs('30m')).toBe(1_800_000)
    expect(browserAgentIdleCloseMs('60m')).toBe(3_600_000)
    expect(browserAgentIdleCloseMs('never')).toBeNull()
  })
})
