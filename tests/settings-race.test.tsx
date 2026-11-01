// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import type { ComposerSession } from '../src/client/composer/session.ts'
import { composerEnhancerCall } from '../src/client/remote.ts'
import { PluginSettings } from '../src/client/dsh/settings.tsx'
import type { ComposerControlsProps } from '../src/client/dsh/controls.tsx'
import type { EnhancerSettings } from '../src/config.ts'

vi.mock('../src/client/styles.module.css', () => ({ default: {}, installCss: () => () => {} }))

const contexts: Context[] = []
afterEach(async () => {
  cleanup()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

it('does not request prediction after an accepted disable before the mirror catches up', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const listeners = new Set<() => void>()
  let value: EnhancerSettings = { historyEnabled: true, optimizeEnabled: true, predictEnabled: true, rollbackEnabled: false }
  let revision = 1
  let snapshot: ReturnType<ConfigForm<EnhancerSettings>['getSnapshot']> = {
    status: 'ready', value, base: undefined, user: undefined, revision, writable: true,
  }
  const form: ConfigForm<EnhancerSettings> = {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: vi.fn(async () => true),
    unset: vi.fn(async () => true),
    mutate: vi.fn(async () => true),
  }
  const registrations: Array<{
    name: string
    options: { inject: (...args: never[]) => unknown }
  }> = []
  ctx.provide('remote', {
    $mount: async () => () => {},
    pluginInventory: { list: async () => { throw new Error('inventory unavailable') } },
  } as never)
  ctx.provide('remote.composerEnhancer', { call: vi.fn() } as never)
  ctx.provide('remote.checkpointRollback', { preview: vi.fn(), execute: vi.fn() } as never)
  ctx.provide('remote.pluginInventory', { list: vi.fn() } as never)
  ctx.provide('configForms', { get: () => form, whileServed: () => () => {} } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key } as never)
  ctx.provide('slots', {
    inject: (_key: string, registerEntry: () => () => void) => { registerEntry(); return () => {} },
    register: (options: { name: string; inject: (...args: never[]) => unknown }) => {
      registrations.push({ name: options.name, options })
      return () => {}
    },
  } as never)
  const invoke = vi.spyOn(composerEnhancerCall, 'invoke').mockImplementation(() => new Promise(() => {}))
  await ctx.plugin({ apply })

  const settings = registrations.find(entry => entry.name === 'settings.plugins.tab')
  const settingsForm = settings!.options.inject() as { form: ConfigForm<EnhancerSettings> }
  const t = ((key: string) => key) as ComposerControlsProps['t']
  render(createElement(PluginSettings, { form: settingsForm.form, t }))
  const right = registrations.find(entry => entry.name === 'conversation.input.right')
  const session = (right!.options.inject('session-1' as never) as { session: ComposerSession }).session
  const sessionId = 'session-1' as SessionId
  session.attach({ replace: () => false, setDraft: () => {} })
  session.sync({ sessionId, draft: '', draftRev: 0, selection: { start: 0, end: 0 }, occurrences: [], running: false }, [], false)

  await act(async () => {
    fireEvent.click(screen.getByRole('switch', { name: 'predict' }))
    await Promise.resolve()
    await Promise.resolve()
  })
  session.sync(
    { sessionId, draft: '', draftRev: 0, selection: { start: 0, end: 0 }, occurrences: [], running: false },
    [{ turn: 1, prompt: 'off now', response: 'done' }],
    false,
  )
  expect(invoke).not.toHaveBeenCalled()

  value = { ...value, predictEnabled: false }
  revision = 2
  snapshot = { status: 'ready', value, base: undefined, user: undefined, revision, writable: true }
  for (const listener of listeners) listener()
  session.sync(
    { sessionId, draft: '', draftRev: 0, selection: { start: 0, end: 0 }, occurrences: [], running: false },
    [{ turn: 2, prompt: 'still off', response: 'done' }],
    false,
  )
  expect(invoke).not.toHaveBeenCalled()

  value = { ...value, predictEnabled: true }
  revision = 3
  snapshot = { status: 'ready', value, base: undefined, user: undefined, revision, writable: true }
  for (const listener of listeners) listener()
  session.sync(
    { sessionId, draft: '', draftRev: 0, selection: { start: 0, end: 0 }, occurrences: [], running: false },
    [{ turn: 3, prompt: 'on again', response: 'done' }],
    false,
  )
  expect(invoke).toHaveBeenCalledTimes(1)
})
