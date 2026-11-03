import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/config.ts'
import { AUTO_MODEL, AUTO_PROVIDER } from '../src/host/auto-route/sentinel.ts'
import {
  isUnconfiguredAutoTierMapping,
  pillLabel,
  selectedPillMenuId,
} from '../src/client/dsh/model-pill-label.ts'
import { encodeFollowSelection } from '../src/client/dsh/model-catalog.ts'

const groups = [{
  id: 'deepseek',
  name: 'DeepSeek',
  models: [{ id: 'deepseek-chat', name: 'Chat' }],
}] as const

describe('model pill labels', () => {
  it('shows follow-session for auxiliary empty selection only', () => {
    expect(pillLabel(
      { provider: '', model: '', reasoningEffort: '' },
      groups,
      'Follow session',
      'Auto',
    )).toBe('Follow session')
  })

  it('shows unconfigured for empty Auto tier mappings', () => {
    const tier = {
      provider: DEFAULT_SETTINGS.autoInstantProvider,
      model: DEFAULT_SETTINGS.autoInstantModel,
      reasoningEffort: DEFAULT_SETTINGS.autoInstantReasoningEffort,
    }
    expect(isUnconfiguredAutoTierMapping(tier)).toBe(true)
    expect(pillLabel(tier, groups, 'Follow session', 'Auto', 'Not set')).toBe('Not set')
    expect(selectedPillMenuId(tier, groups, { tierMapping: true })).toBe('')
    expect(selectedPillMenuId(tier, groups, { tierMapping: true })).not.toBe(encodeFollowSelection())
  })

  it('shows Auto label for sentinel tier selection', () => {
    expect(pillLabel(
      { provider: AUTO_PROVIDER, model: AUTO_MODEL, reasoningEffort: '' },
      groups,
      'Follow session',
      'Auto',
      'Not set',
    )).toBe('Auto')
  })
})
