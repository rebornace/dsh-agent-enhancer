import { describe, expect, it, vi } from 'vitest'
import {
  ENHANCER_SETTINGS_NS,
  persistEnhancerSettings,
  withSettingsRemote,
} from '../src/client/dsh/persist-settings.ts'

describe('persistEnhancerSettings', () => {
  it('writes model fields with arity-3 mutate using the current revision', async () => {
    const mutate = vi.fn(async () => ({ ok: true as const, value: {} }))
    const remote = { settings: { mutate } }
    await persistEnhancerSettings(remote, [
      { op: 'set', path: ['optimizeProvider'], value: 'deepseek-official' },
      { op: 'set', path: ['optimizeModel'], value: 'deepseek-flash' },
      { op: 'set', path: ['optimizeReasoningEffort'], value: 'low' },
    ], () => 4)
    expect(mutate).toHaveBeenCalledTimes(1)
    const call = mutate.mock.calls.at(0) as unknown as
      | readonly [string, readonly unknown[], number]
      | undefined
    expect(call?.[0]).toBe(ENHANCER_SETTINGS_NS)
    expect(call?.[1]).toHaveLength(3)
    expect(call?.[2]).toBe(4)
    expect(call?.length).toBe(3)
  })

  it('retries once after describe when the first write is refused', async () => {
    const mutate = vi.fn(async (_ns: string, _ops: unknown, expected: number) => {
      if (expected === 1) {
        return {
          ok: false as const,
          error: { message: `settings namespace "${ENHANCER_SETTINGS_NS}" changed (expected ${expected})` },
        }
      }
      return { ok: true as const, value: {} }
    })
    const describe = vi.fn(async () => ({
      ok: true as const,
      value: {
        namespaces: [{ ns: ENHANCER_SETTINGS_NS, revision: 7 }],
      },
    }))
    const remote = { settings: { mutate, describe } }
    await persistEnhancerSettings(remote, [
      { op: 'set', path: ['optimizeModel'], value: 'deepseek-flash' },
    ], () => 1)
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(describe).toHaveBeenCalledTimes(1)
    const second = mutate.mock.calls.at(1) as unknown as
      | readonly [string, readonly unknown[], number]
      | undefined
    expect(second?.[2]).toBe(7)
  })

  it('throws Host refusal detail when both attempts fail', async () => {
    const remote = {
      settings: {
        mutate: async () => ({
          ok: false as const,
          error: { message: 'settings namespace "agent-enhancer" changed since it was read' },
        }),
        describe: async () => ({
          ok: true as const,
          value: { namespaces: [{ ns: ENHANCER_SETTINGS_NS, revision: 2 }] },
        }),
      },
    }
    await expect(persistEnhancerSettings(remote, [
      { op: 'set', path: ['optimizeModel'], value: 'deepseek-flash' },
    ], () => 1)).rejects.toThrow(/changed since it was read/)
  })

  it('lazy-injects remote.settings for one save then disposes', async () => {
    const mutate = vi.fn(async () => ({ ok: true as const, value: {} }))
    const dispose = vi.fn(async () => undefined)
    const ctx = {
      inject: vi.fn((deps: readonly string[], callback: (scope: { remote: unknown }) => void) => {
        expect(deps).toEqual(['remote.settings'])
        callback({ remote: { settings: { mutate } } })
        return { dispose }
      }),
    }
    await withSettingsRemote(ctx, remote => persistEnhancerSettings(remote, [
      { op: 'set', path: ['optimizeModel'], value: 'deepseek-flash' },
    ], () => 3))
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
