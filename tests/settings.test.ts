import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  MODULES,
  auxiliaryModelOf,
  isFollowSessionModel,
  resolveSettings,
} from '../src/config.ts'
import { KNOWN_OVERLAPS, overlapHints } from '../src/client/dsh/plugin-hints.ts'
import {
  decodeModelSelection,
  encodeEffortSelection,
  encodeFollowSelection,
  encodeModelSelection,
  loadDesktopModelCatalog,
  modelOptionValue,
  parseModelOptionValue,
} from '../src/client/dsh/model-catalog.ts'

describe('composer settings', () => {
  it('enables history, optimize, predict, and rollback by default', () => {
    expect(MODULES).toEqual(['history', 'optimize', 'predict', 'rollback'])
    expect(DEFAULT_SETTINGS).toEqual({
      historyEnabled: true,
      optimizeEnabled: true,
      predictEnabled: true,
      rollbackEnabled: true,
      optimizeProvider: '',
      optimizeModel: '',
      optimizeReasoningEffort: '',
      predictProvider: '',
      predictModel: '',
      predictReasoningEffort: '',
    })
    expect(resolveSettings(undefined)).toEqual(DEFAULT_SETTINGS)
  })

  it('preserves every explicit false value and blank model overrides', () => {
    expect(resolveSettings({
      historyEnabled: false,
      optimizeEnabled: false,
      predictEnabled: false,
      rollbackEnabled: false,
    })).toEqual({
      historyEnabled: false,
      optimizeEnabled: false,
      predictEnabled: false,
      rollbackEnabled: false,
      optimizeProvider: '',
      optimizeModel: '',
      optimizeReasoningEffort: '',
      predictProvider: '',
      predictModel: '',
      predictReasoningEffort: '',
    })
  })

  it('serializes no completion, template, strength, or candidate settings', () => {
    const serialized = JSON.stringify(resolveSettings({ historyEnabled: false }))
    expect(JSON.parse(serialized)).toEqual({
      historyEnabled: false,
      optimizeEnabled: true,
      predictEnabled: true,
      rollbackEnabled: true,
      optimizeProvider: '',
      optimizeModel: '',
      optimizeReasoningEffort: '',
      predictProvider: '',
      predictModel: '',
      predictReasoningEffort: '',
    })
    for (const forbidden of ['completion', 'template', 'strength', 'candidate']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('treats empty provider or model as follow-session and keeps feature-specific overrides', () => {
    expect(isFollowSessionModel(auxiliaryModelOf(DEFAULT_SETTINGS, 'optimize'))).toBe(true)
    const configured = resolveSettings({
      optimizeProvider: 'deepseek',
      optimizeModel: 'deepseek-chat',
      optimizeReasoningEffort: 'low',
      predictProvider: 'openai',
      predictModel: '',
    })
    expect(auxiliaryModelOf(configured, 'optimize')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'low',
    })
    expect(isFollowSessionModel(auxiliaryModelOf(configured, 'predict'))).toBe(true)
  })

  it('round-trips catalog option values without colliding on provider names', () => {
    const value = modelOptionValue('deepseek', 'deepseek-chat')
    expect(parseModelOptionValue(value)).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(parseModelOptionValue('')).toBeNull()
    expect(parseModelOptionValue('missing-separator')).toBeNull()
    expect(decodeModelSelection(encodeFollowSelection())).toEqual({ kind: 'follow' })
    expect(decodeModelSelection(encodeModelSelection('deepseek', 'deepseek-chat'))).toEqual({
      kind: 'model',
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: '',
    })
    expect(decodeModelSelection(encodeEffortSelection('deepseek', 'deepseek-chat', 'high'))).toEqual({
      kind: 'model',
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
    })
  })

  it('prefers session.modelCatalog and falls back to composerEnhancer.listCatalog', async () => {
    const catalog = {
      default: { provider: 'deepseek', model: 'deepseek-chat' },
      routableProviders: ['deepseek'],
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'Chat' }] }],
      failures: [],
    }
    await expect(loadDesktopModelCatalog({
      session: { modelCatalog: async () => ({ ok: true, value: catalog }) },
    })).resolves.toEqual(catalog)

    const listCatalog = vi.fn(async () => ({ ok: true as const, value: catalog }))
    await expect(loadDesktopModelCatalog({
      sessionModelCatalog: async () => ({ ok: false as const, error: { code: 'x', message: '', details: {} } }),
      hostListCatalog: listCatalog,
    })).resolves.toEqual(catalog)
    expect(listCatalog).toHaveBeenCalledTimes(1)
  })

  it('soft-probes Cordis remotes that throw without inject instead of crashing settings', async () => {
    const catalog = {
      default: { provider: 'deepseek', model: 'deepseek-chat' },
      routableProviders: ['deepseek'],
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'Chat' }] }],
      failures: [],
    }
    const remote = {
      get session() {
        throw new Error('cannot get property "remote.session" without inject')
      },
      composerEnhancer: {
        listCatalog: async () => ({ ok: true as const, value: catalog }),
      },
    }
    await expect(loadDesktopModelCatalog(remote)).resolves.toEqual(catalog)
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
