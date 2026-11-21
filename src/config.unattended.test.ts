import { describe, expect, it } from 'vitest'
import {
  BROWSER_AGENT_UNATTENDED,
  DEFAULT_SETTINGS,
  resolveBrowserAgentUnattendedActions,
  resolveBrowserAgentUnattendedMinutes,
  resolveSettings,
} from './config.ts'

describe('unattended grant bounds', () => {
  it('defaults to 20 minutes / 30 actions', () => {
    expect(BROWSER_AGENT_UNATTENDED.minutes.default).toBe(20)
    expect(BROWSER_AGENT_UNATTENDED.actions.default).toBe(30)
    expect(DEFAULT_SETTINGS.browserAgentUnattendedMinutes).toBe(20)
    expect(DEFAULT_SETTINGS.browserAgentUnattendedActions).toBe(30)
  })

  it('clamps saved values to the documented range', () => {
    expect(resolveBrowserAgentUnattendedMinutes(1)).toBe(5)
    expect(resolveBrowserAgentUnattendedMinutes(999)).toBe(60)
    expect(resolveBrowserAgentUnattendedMinutes(25.4)).toBe(25)
    expect(resolveBrowserAgentUnattendedMinutes('30')).toBe(30)
    expect(resolveBrowserAgentUnattendedMinutes(undefined)).toBe(20)
    expect(resolveBrowserAgentUnattendedMinutes('')).toBe(20)

    expect(resolveBrowserAgentUnattendedActions(1)).toBe(10)
    expect(resolveBrowserAgentUnattendedActions(9999)).toBe(200)
    expect(resolveBrowserAgentUnattendedActions('90')).toBe(90)
    expect(resolveBrowserAgentUnattendedActions('many')).toBe(30)
  })

  it('reads through resolveSettings', () => {
    const settings = resolveSettings({
      browserAgentUnattendedMinutes: 45,
      browserAgentUnattendedActions: 90,
    })
    expect(settings.browserAgentUnattendedMinutes).toBe(45)
    expect(settings.browserAgentUnattendedActions).toBe(90)
  })
})
