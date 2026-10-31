import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, MODULES, resolveSettings } from '../src/config.ts'
import { KNOWN_OVERLAPS, overlapHints } from '../src/client/dsh/plugin-hints.ts'

describe('composer settings', () => {
  it('enables exactly history, optimize, and predict by default', () => {
    expect(MODULES).toEqual(['history', 'optimize', 'predict'])
    expect(DEFAULT_SETTINGS).toEqual({
      historyEnabled: true,
      optimizeEnabled: true,
      predictEnabled: true,
    })
    expect(resolveSettings(undefined)).toEqual(DEFAULT_SETTINGS)
  })

  it('preserves every explicit false value', () => {
    expect(resolveSettings({
      historyEnabled: false,
      optimizeEnabled: false,
      predictEnabled: false,
    })).toEqual({
      historyEnabled: false,
      optimizeEnabled: false,
      predictEnabled: false,
    })
  })

  it('serializes no completion, template, strength, or candidate settings', () => {
    const serialized = JSON.stringify(resolveSettings({ historyEnabled: false }))
    expect(JSON.parse(serialized)).toEqual({
      historyEnabled: false,
      optimizeEnabled: true,
      predictEnabled: true,
    })
    for (const forbidden of ['completion', 'template', 'strength', 'candidate']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('recognizes only enabled entries from the maintained overlap list', () => {
    expect(KNOWN_OVERLAPS).toEqual({
      history: ['dsh-composer-history', 'dsh-prompt-history', 'dsh-input-assistant'],
      optimize: ['dsh-input-assistant'],
      predict: ['dsh-reply-suggestions', 'dsh-prompt-history', 'dsh-input-assistant'],
    })
    expect(overlapHints([
      { moduleName: 'dsh-input-assistant', enabled: true },
      { moduleName: 'dsh-reply-suggestions', enabled: false },
      { moduleName: 'unrelated-plugin', enabled: true },
    ])).toEqual(['history', 'optimize', 'predict'])
    expect(resolveSettings(undefined)).toEqual(DEFAULT_SETTINGS)
  })
})
