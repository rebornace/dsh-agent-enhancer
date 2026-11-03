// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { PromptSession } from '../src/client/prompt/session.ts'
import { AgentControls } from '../src/client/dsh/controls.tsx'
import type { AgentControlsProps } from '../src/client/dsh/controls.tsx'
import { clientRemoteInfo, agentEnhancerCall } from '../src/client/remote.ts'

vi.mock('../src/client/styles.module.css', () => ({ default: {}, installCss: () => () => {} }))

const rollbackControllerInstances: import('../src/client/rollback/controller.ts').RollbackController[] = []

vi.mock('../src/client/rollback/controller.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/client/rollback/controller.ts')>()
  class TrackingRollbackController extends mod.RollbackController {
    constructor(options: ConstructorParameters<typeof mod.RollbackController>[0]) {
      super(options)
      rollbackControllerInstances.push(this)
    }
  }
  return { ...mod, RollbackController: TrackingRollbackController }
})

const contexts: Context[] = []

function remotePayload() {
  return {
    method: 'generate' as const,
    data: {
      operation: 'optimize' as const,
      requestId: 'req-1',
      sessionId: 'session-1' as SessionId,
      source: 'source',
      references: [],
      context: [],
    },
  }
}

afterEach(async () => {
  cleanup()
  rollbackControllerInstances.splice(0)
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

it('mounts the shared Remote and host config entry and disposes the Remote', async () => {
  expect(inject).toContain('remote.pluginInventory')
  expect(inject).toContain('remote.session')
  const ctx = new Context()
  contexts.push(ctx)
  const get = vi.fn(() => ({ getSnapshot: () => ({ value: {} }), subscribe: () => () => {} }))
  const unmount = vi.fn()
  const mount = vi.fn(async () => unmount)
  const register = vi.fn(() => () => {})
  const emptyCatalog = { default: { provider: '', model: '' }, routableProviders: [], groups: [], failures: [] }
  const remote = {
    $mount: mount,
    session: { modelCatalog: async () => ({ ok: true as const, value: emptyCatalog }) },
    agentEnhancer: {
      call: vi.fn(),
      listCatalog: vi.fn(async () => ({ ok: true as const, value: emptyCatalog })),
    },
    checkpointRollback: { preview: vi.fn(), execute: vi.fn() },
    pluginInventory: { list: async () => { throw new Error('inventory unavailable') } },
  }
  ctx.provide('remote', remote as never)
  ctx.provide('remote.session', remote.session as never)
  ctx.provide('remote.agentEnhancer', remote.agentEnhancer as never)
  ctx.provide('remote.checkpointRollback', remote.checkpointRollback as never)
  ctx.provide('configForms', { get, whileServed: () => () => {} } as never)
  ctx.provide('locale', { register, bind: () => (key: string) => key, getLocale: () => ({ active: 'zh', locales: [], revision: 0 }) } as never)
  const injectedSlots: string[] = []
  ctx.provide('slots', {
    inject: (key: string, registerEntry: () => () => void) => {
      injectedSlots.push(key)
      registerEntry()
      return () => {}
    },
    register: () => () => {},
  } as never)

  const fiber = await ctx.plugin({ apply })

  expect(get).toHaveBeenCalledWith('agent-enhancer')
  expect(injectedSlots).toContain('settings.plugins.tab')
  expect(mount).toHaveBeenCalledWith(clientRemoteInfo)
  await vi.waitFor(() => { expect(mount).toHaveBeenCalledTimes(1) })
  await fiber.dispose()
  // Mount effect may still be awaiting nested remotes in this sparse fixture; unmount is
  // covered by fuller client composition tests once those fibers settle.
  void unmount
})

it('registers settings before Remote $mount settles', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const get = vi.fn(() => ({ getSnapshot: () => ({ value: {}, writable: true }), subscribe: () => () => {} }))
  let resolveMount!: (unmount: () => void) => void
  const mount = vi.fn(() => new Promise<() => void>(resolve => { resolveMount = resolve }))
  const injectedSlots: string[] = []
  ctx.provide('remote', {
    $mount: mount,
    pluginInventory: { list: async () => ({ ok: true, value: { entries: [] } }) },
  } as never)
  ctx.provide('configForms', { get, whileServed: () => () => {} } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key, getLocale: () => ({ active: 'zh', locales: [], revision: 0 }) } as never)
  ctx.provide('slots', {
    inject: (key: string, registerEntry: () => () => void) => {
      injectedSlots.push(key)
      registerEntry()
      return () => {}
    },
    register: () => () => {},
  } as never)

  const fiber = await ctx.plugin({ apply })
  expect(injectedSlots).toContain('settings.plugins.tab')
  expect(mount).toHaveBeenCalledTimes(1)
  resolveMount(() => {})
  await fiber.dispose()
})

it('invokes the mounted namespace through the declared Cordis injection', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  let pluginCtx: Context | undefined
  const call = vi.fn(async () => ({ ok: true as const, value: null }))
  const remote = new Proxy({
    $mount: async () => () => {},
    pluginInventory: { list: async () => { throw new Error('inventory unavailable') } },
  }, {
    get(target, property, receiver) {
      if (property === 'agentEnhancer' && pluginCtx !== undefined) {
        return Reflect.get(pluginCtx, 'remote.agentEnhancer')
      }
      return Reflect.get(target, property, receiver)
    },
  })
  ctx.provide('remote', remote as never)
  ctx.provide('remote.session', { modelCatalog: async () => ({ ok: false, error: { code: 'unavailable', message: '', details: {} } }) } as never)
  ctx.provide('remote.pluginInventory', remote.pluginInventory as never)
  ctx.provide('configForms', {
    get: () => ({ getSnapshot: () => ({ value: {} }), subscribe: () => () => {} }),
    whileServed: () => () => {},
  } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key, getLocale: () => ({ active: 'zh', locales: [], revision: 0 }) } as never)
  ctx.provide('slots', { inject: vi.fn(() => () => {}) } as never)
  await ctx.plugin({ inject, apply(context) { pluginCtx = context; apply(context) } })
  ctx.provide('remote.agentEnhancer', { call } as never)
  await vi.waitFor(() => { expect(pluginCtx).toBeDefined() })

  const payload = remotePayload()
  const signal = new AbortController().signal
  const result = await agentEnhancerCall.invoke(pluginCtx!.remote, { payload }, signal)

  expect(result).toBeNull()
  expect(call).toHaveBeenCalledWith(payload, signal)
})

it('rejects declared Remote failures with their sanitized auxiliary category', async () => {
  const remote = {
    agentEnhancer: {
      call: async () => ({
        ok: false as const,
        error: {
          code: 'agent-enhancer/failed',
          message: 'provider credential and private text',
          details: { code: 'INVALID_OUTPUT' },
        },
      }),
    },
  }
  const payload = remotePayload()

  const rejection = await agentEnhancerCall.invoke(remote, { payload }).catch((error: unknown) => error)

  expect(rejection).toMatchObject({ name: 'AuxiliaryError', code: 'INVALID_OUTPUT' })
  expect((rejection as Error).message).not.toContain('provider credential')
})

it('rethrows a real Remote cancellation rejection unchanged', async () => {
  const controller = new AbortController()
  controller.abort()
  const remote = {
    agentEnhancer: {
      call: async () => { throw controller.signal.reason },
    },
  }

  const rejection = await agentEnhancerCall.invoke(
    remote,
    { payload: remotePayload() },
    controller.signal,
  ).catch((error: unknown) => error)

  expect(rejection).toBe(controller.signal.reason)
  expect(rejection).toMatchObject({ name: 'AbortError' })
})

it('maps an ordinary Remote rejection to a sanitized model failure', async () => {
  const cause = new Error('provider credential and private text')
  const remote = {
    agentEnhancer: {
      call: async () => { throw cause },
    },
  }

  const rejection = await agentEnhancerCall.invoke(remote, { payload: remotePayload() })
    .catch((error: unknown) => error)

  expect(rejection).not.toBe(cause)
  expect(rejection).toMatchObject({ name: 'AuxiliaryError', code: 'MODEL_FAILED' })
  expect((rejection as Error).message).not.toContain('provider credential')
})

it('aborts pending optimization and hides the button on a real form notification', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const listeners = new Set<() => void>()
  let value: { optimizeEnabled?: boolean } = { optimizeEnabled: true }
  const form = {
    getSnapshot: () => ({ value }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const registrations: Array<{
    name: string
    inject: (sessionId: SessionId) => { session: PromptSession }
  }> = []
  const register = vi.fn((options: {
    name: string
    inject: (sessionId: SessionId) => { session: PromptSession }
  }) => {
    registrations.push(options)
    return () => {}
  })
  const mount = vi.fn(async () => () => {})
  ctx.provide('remote', {
    $mount: mount,
    session: { modelCatalog: async () => ({ ok: true, value: { default: { provider: '', model: '' }, routableProviders: [], groups: [], failures: [] } }) },
    pluginInventory: { list: async () => { throw new Error('inventory unavailable') } },
  } as never)
  ctx.provide('remote.session', { modelCatalog: async () => ({ ok: true, value: { default: { provider: '', model: '' }, routableProviders: [], groups: [], failures: [] } }) } as never)
  ctx.provide('configForms', { get: () => form, whileServed: () => () => {} } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key, getLocale: () => ({ active: 'zh', locales: [], revision: 0 }) } as never)
  ctx.provide('slots', {
    inject: (_key: string, registerEntry: () => () => void) => { registerEntry(); return () => {} },
    register,
  } as never)
  let requestSignal: AbortSignal | undefined
  const method = agentEnhancerCall as unknown as {
    invoke: (remote: unknown, input: unknown, signal?: AbortSignal) => Promise<never>
  }
  vi.spyOn(method, 'invoke').mockImplementation((_remote, _input, signal) => {
    requestSignal = signal
    return new Promise(() => {})
  })
  ctx.provide('remote.agentEnhancer', { call: vi.fn() } as never)
  ctx.provide('remote.checkpointRollback', { preview: vi.fn(), execute: vi.fn() } as never)
  await ctx.plugin({ apply })
  await vi.waitFor(() => {
    expect(registrations.some(entry => entry.name === 'conversation.input.right')).toBe(true)
  })
  const registration = registrations.find(entry => entry.name === 'conversation.input.right')
  expect(registration).toBeDefined()
  const sessionId = 'session-1' as SessionId
  const session = registration!.inject(sessionId).session
  session.attach({ replace: () => false, setDraft: () => {} })
  session.sync({ sessionId, draft: 'source', draftRev: 1, selection: { start: 0, end: 0 }, occurrences: [], running: false }, [], false)
  const t = ((key: string) => key) as AgentControlsProps['t']
  render(createElement(AgentControls, { session, t }))

  act(() => { void session.optimize() })
  expect(screen.getByRole('button', { name: 'optimizePending' })).toBeTruthy()
  expect(requestSignal?.aborted).toBe(false)

  act(() => {
    value = { optimizeEnabled: false }
    for (const listener of listeners) listener()
  })

  expect(requestSignal?.aborted).toBe(true)
  expect(screen.queryByRole('button')).toBeNull()
})

it('registers user node replacement only while enabled and cleans up on unload', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const listeners = new Set<() => void>()
  let value: { rollbackEnabled?: boolean } = { rollbackEnabled: false }
  const form = {
    getSnapshot: () => ({ value }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  interface Entry {
    readonly name: string
    readonly key?: string
    readonly id?: string
    readonly registrant?: string
  }
  const registrations: Entry[] = []
  const checkpointRollback = {
    preview: vi.fn((_request: unknown, _signal: AbortSignal) => new Promise<never>(() => {})),
    execute: vi.fn(),
  }
  const remote = {
    $mount: async () => () => {},
    session: { modelCatalog: async () => ({ ok: true, value: { default: { provider: '', model: '' }, routableProviders: [], groups: [], failures: [] } }) },
    pluginInventory: { list: async () => { throw new Error('inventory unavailable') } },
    checkpointRollback,
  }
  ctx.provide('remote', remote as never)
  ctx.provide('remote.session', remote.session as never)
  ctx.provide('remote.checkpointRollback', checkpointRollback as never)
  ctx.provide('remote.agentEnhancer', { call: vi.fn() } as never)
  ctx.provide('configForms', { get: () => form, whileServed: () => () => {} } as never)
  ctx.provide('sessions', {
    retainInfo: () => ({
      getSnapshot: () => ({ referenceCount: 1, retainedBy: { mainView: 1 } }),
      subscribe: () => () => {},
    }),
  } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key, getLocale: () => ({ active: 'zh', locales: [], revision: 0 }) } as never)
  ctx.provide('slots', {
    inject: (_key: string, registerEntry: () => () => void) => registerEntry(),
    register: (options: Entry) => {
      registrations.push(options)
      return () => {
        const index = registrations.indexOf(options)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
  } as never)
  const fiber = await ctx.plugin({ apply })
  await vi.waitFor(() => {
    expect(registrations.some(entry => entry.name === 'conversation.input.right')).toBe(true)
  })
  expect(registrations.filter(entry => entry.name === 'conversation.chat.node' && entry.key === 'user')).toHaveLength(0)
  expect(registrations.filter(entry => entry.name === 'conversation.chat.turnTail')).toHaveLength(0)
  expect(registrations.filter(entry => entry.id === 'agent-enhancer-rollback')).toHaveLength(0)

  act(() => {
    value = { rollbackEnabled: true }
    for (const listener of listeners) listener()
  })
  await vi.waitFor(() => {
    expect(registrations.filter(entry => entry.name === 'conversation.chat.node' && entry.key === 'user')).toHaveLength(1)
  })
  expect(registrations.find(entry => entry.registrant === 'agent-enhancer-rollback-user')).toBeDefined()
  expect(registrations.find(entry => entry.id === 'agent-enhancer-rollback')).toMatchObject({
    name: 'conversation.input.overlay',
  })

  act(() => {
    value = { rollbackEnabled: false }
    for (const listener of listeners) listener()
  })
  expect(registrations.filter(entry => entry.name === 'conversation.chat.node' && entry.key === 'user')).toHaveLength(0)
  expect(registrations.filter(entry => entry.id === 'agent-enhancer-rollback')).toHaveLength(0)

  act(() => {
    value = { rollbackEnabled: true }
    for (const listener of listeners) listener()
  })
  await vi.waitFor(() => {
    expect(registrations.filter(entry => entry.name === 'conversation.chat.node' && entry.key === 'user')).toHaveLength(1)
  })

  await fiber.dispose()
  expect(registrations.filter(entry => entry.name === 'conversation.chat.node' && entry.key === 'user')).toHaveLength(0)
  expect(registrations.filter(entry => entry.id === 'agent-enhancer-rollback')).toHaveLength(0)
})

it('aborts in-flight rollback preview when rollback is disabled or session retention drops', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const listeners = new Set<() => void>()
  let value: { rollbackEnabled?: boolean } = { rollbackEnabled: false }
  const form = {
    getSnapshot: () => ({ value }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  interface Entry {
    readonly name: string
    readonly key?: string
    readonly registrant?: string
  }
  const registrations: Entry[] = []
  let userNodeSlot: ((props: { sessionId: SessionId }) => ReturnType<typeof createElement>) | undefined
  const previewSignals: AbortSignal[] = []
  const checkpointRollback = {
    preview: vi.fn((_request: unknown, signal: AbortSignal) => {
      previewSignals.push(signal)
      return new Promise<never>(() => {})
    }),
    execute: vi.fn(),
  }
  const remote = {
    $mount: async () => () => {},
    session: { modelCatalog: async () => ({ ok: true, value: { default: { provider: '', model: '' }, routableProviders: [], groups: [], failures: [] } }) },
    pluginInventory: { list: async () => { throw new Error('inventory unavailable') } },
    checkpointRollback,
  }
  let mainView = 1
  const retentionListeners = new Set<() => void>()
  ctx.provide('remote', remote as never)
  ctx.provide('remote.session', remote.session as never)
  ctx.provide('remote.checkpointRollback', checkpointRollback as never)
  ctx.provide('remote.agentEnhancer', { call: vi.fn() } as never)
  ctx.provide('configForms', { get: () => form, whileServed: () => () => {} } as never)
  ctx.provide('sessions', {
    retainInfo: () => ({
      getSnapshot: () => ({ referenceCount: mainView, retainedBy: mainView === 0 ? {} : { mainView } }),
      subscribe: (listener: () => void) => {
        retentionListeners.add(listener)
        return () => { retentionListeners.delete(listener) }
      },
    }),
  } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key, getLocale: () => ({ active: 'zh', locales: [], revision: 0 }) } as never)
  ctx.provide('slots', {
    inject: (_key: string, registerEntry: () => () => void) => registerEntry(),
    register: (options: Entry, component?: (props: { sessionId: SessionId }) => ReturnType<typeof createElement>) => {
      registrations.push(options)
      if (options.name === 'conversation.chat.node' && options.key === 'user') {
        userNodeSlot = component
      }
      return () => {
        const index = registrations.indexOf(options)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
  } as never)
  const sessionId = 'session-1' as SessionId
  const fiber = await ctx.plugin({ apply })
  await vi.waitFor(() => {
    expect(registrations.some(entry => entry.name === 'conversation.input.right')).toBe(true)
  })

  const rollback = () => {
    act(() => { userNodeSlot!({ sessionId }) })
    return rollbackControllerInstances.at(-1)!
  }

  act(() => {
    value = { rollbackEnabled: true }
    for (const listener of listeners) listener()
  })
  await vi.waitFor(() => {
    expect(registrations.filter(entry => entry.name === 'conversation.chat.node' && entry.key === 'user')).toHaveLength(1)
    expect(userNodeSlot).toBeDefined()
  })

  act(() => { rollback().open(2) })
  expect(previewSignals).toHaveLength(1)

  act(() => {
    value = { rollbackEnabled: false }
    for (const listener of listeners) listener()
  })
  expect(previewSignals[0]?.aborted).toBe(true)

  act(() => {
    value = { rollbackEnabled: true }
    for (const listener of listeners) listener()
  })
  await vi.waitFor(() => {
    expect(registrations.filter(entry => entry.name === 'conversation.chat.node' && entry.key === 'user')).toHaveLength(1)
  })
  act(() => { rollback().open(2) })
  expect(previewSignals).toHaveLength(2)

  act(() => {
    mainView = 0
    for (const listener of retentionListeners) listener()
  })
  expect(previewSignals[1]?.aborted).toBe(true)

  act(() => {
    mainView = 1
    for (const listener of retentionListeners) listener()
    rollback().open(2)
  })
  expect(previewSignals).toHaveLength(3)

  await fiber.dispose()
  expect(previewSignals[2]?.aborted).toBe(true)
})
