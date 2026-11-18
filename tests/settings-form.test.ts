import { describe, expect, it, vi } from 'vitest'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { AcceptedSettingsForm } from '../src/client/dsh/settings-form.ts'
import type { EnhancerSettings } from '../src/config.ts'
import { DEFAULT_SETTINGS } from '../src/config.ts'

describe('AcceptedSettingsForm', () => {
  it('saves model fields in one mutate without pinning a pre-queue revision', async () => {
    let revision = 1
    let value: EnhancerSettings = { ...DEFAULT_SETTINGS }
    const listeners = new Set<() => void>()
    const mutate = vi.fn(async (ops: readonly { op: string, path: readonly string[], value?: unknown }[], expected?: number) => {
      expect(expected).toBeUndefined()
      for (const op of ops) {
        if (op.op === 'set' && op.path.length === 1) {
          value = { ...value, [op.path[0] as keyof EnhancerSettings]: op.value as never }
        }
      }
      revision += 1
      for (const listener of listeners) listener()
      return true
    })
    const inner: ConfigForm<EnhancerSettings> = {
      getSnapshot: () => ({
        status: 'ready',
        value,
        base: undefined,
        user: undefined,
        revision,
        writable: true,
      }),
      subscribe: listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: vi.fn(async () => false),
      unset: vi.fn(async () => false),
      mutate,
    }
    const form = new AcceptedSettingsForm(inner)
    const accepted = await form.mutate([
      { op: 'set', path: ['optimizeProvider'], value: 'deepseek-official' },
      { op: 'set', path: ['optimizeModel'], value: 'deepseek-flash' },
      { op: 'set', path: ['optimizeReasoningEffort'], value: 'low' },
    ])
    expect(accepted).toBe(true)
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate.mock.calls[0]?.[0]).toHaveLength(3)
    expect(mutate.mock.calls[0]?.[1]).toBeUndefined()
    expect(inner.set).not.toHaveBeenCalled()
    expect(form.getSnapshot().value?.optimizeModel).toBe('deepseek-flash')
  })

  it('retries once when the first mutate is refused after Host recovery', async () => {
    let revision = 1
    let value: EnhancerSettings = { ...DEFAULT_SETTINGS }
    const listeners = new Set<() => void>()
    const mutate = vi.fn(async (ops: readonly { op: string, path: readonly string[], value?: unknown }[]) => {
      if (mutate.mock.calls.length === 1) {
        revision += 1
        for (const listener of listeners) listener()
        return false
      }
      for (const op of ops) {
        if (op.op === 'set' && op.path.length === 1) {
          value = { ...value, [op.path[0] as keyof EnhancerSettings]: op.value as never }
        }
      }
      revision += 1
      for (const listener of listeners) listener()
      return true
    })
    const inner: ConfigForm<EnhancerSettings> = {
      getSnapshot: () => ({
        status: 'ready',
        value,
        base: undefined,
        user: undefined,
        revision,
        writable: true,
      }),
      subscribe: listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: vi.fn(async () => false),
      unset: vi.fn(async () => false),
      mutate,
    }
    const form = new AcceptedSettingsForm(inner)
    expect(await form.mutate([
      { op: 'set', path: ['optimizeProvider'], value: 'deepseek-official' },
      { op: 'set', path: ['optimizeModel'], value: 'deepseek-flash' },
      { op: 'set', path: ['optimizeReasoningEffort'], value: '' },
    ])).toBe(true)
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(form.getSnapshot().value?.optimizeModel).toBe('deepseek-flash')
  })
})
