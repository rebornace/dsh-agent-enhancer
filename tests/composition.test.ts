// @vitest-environment jsdom
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import * as clientStore from '@deepseek-ai/dsh-client-store'
import * as clientPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AgentContext, ISessions, MutableSessionEventSource, SessionBinding, SessionFace,
  SessionListState, SessionReference, SessionRetainInfo, SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ConfigForm, ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { act, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import type { EnhancerSettings } from '../src/config.ts'

function rollbackUserNodeEntries(ctx: Context) {
  return ctx.slots.entries('conversation.chat.node').filter(entry => entry.options.key === 'user'
    && entry.registrant === 'agent-enhancer-rollback-user')
}

const staticModules: Record<string, unknown> = {
  '@deepseek-ai/dsh-client-store': clientStore,
  '@deepseek-ai/dsh-client-ui-primitives': clientPrimitives,
}
const SESSION_ID = 'session-1' as SessionId
const WORKSPACES = { items: [], phase: 'ready' }

interface ClientRegistration {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

function installClientModules() {
  const target = window as unknown as {
    __ModuleLoader__?: { load(registration: ClientRegistration): void }
  }
  const previous = target.__ModuleLoader__
  const registrations = new Map<string, ClientRegistration>()
  const materialized = new Map<string, unknown>()
  const imported = new Map<string, ClientRegistration>()
  target.__ModuleLoader__ = {
    load(registration) { registrations.set(registration.id, registration) },
  }
  const moduleId = (specifier: string) => specifier.replace(/\/client$/, '')
  const requireModule = (specifier: string): unknown => {
    const id = moduleId(specifier)
    if (id in staticModules) return staticModules[id]
    if (materialized.has(id)) return materialized.get(id)
    const registered = registrations.get(id)
    if (registered !== undefined) return materialize(registered)
    try {
      const exported = require(specifier)
      const arrived = registrations.get(id)
      return arrived === undefined ? exported : materialize(arrived)
    } catch (error) {
      throw new Error(`Client module require failed: ${specifier}`, { cause: error })
    }
  }
  function materialize(registration: ClientRegistration): unknown {
    const cached = materialized.get(registration.id)
    if (cached !== undefined) return cached
    const exported = registration.factory(requireModule)
    materialized.set(registration.id, exported)
    return exported
  }
  let queue = Promise.resolve()
  return {
    import: (specifier: string, nativeImport: (id: string) => Promise<unknown>) => {
      const run = async () => {
        const cached = imported.get(specifier)
        if (cached !== undefined) return materialize(cached)
        const before = new Set(registrations.keys())
        const namespace = await nativeImport(specifier) as Record<string, unknown>
        const arrived = [...registrations].find(([id]) => !before.has(id))?.[1]
        if (arrived !== undefined) imported.set(specifier, arrived)
        return arrived === undefined ? namespace : materialize(arrived)
      }
      const result = queue.then(run, run)
      queue = result.then(() => {}, () => {})
      return result
    },
    require: requireModule,
    restore: () => { target.__ModuleLoader__ = previous },
  }
}

function fixtureSessions(
  ctx: Context,
  sessionController: typeof import('@deepseek-ai/dsh-api-session-controller/client'),
): {
  sessions: ISessions
  reference: SessionReference
  eventSource: MutableSessionEventSource
} {
  const snapshot: SessionSnapshot = {
    sessionId: SESSION_ID,
    pendingSubmissions: [],
    running: false,
    subagent: null,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    promptAttempted: false,
    awaitingFirstTurn: false,
  }
  const absent = { getSnapshot: () => undefined, subscribe: () => () => {} }
  const session = {
    sessionId: SESSION_ID,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    projections: { faceOf: () => absent },
  } as unknown as SessionFace
  const scope = ctx.plugin({ apply() {} })
  const eventSource = new sessionController.MutableSessionEventSource()
  const binding: SessionBinding = {
    sessionId: SESSION_ID, session, eventSource, ctx: scope.ctx as AgentContext,
  }
  const reference = {
    sessionId: SESSION_ID,
    binding,
    ready: Promise.resolve(binding),
    release: () => {},
  } as SessionReference
  const retained: SessionRetainInfo = { referenceCount: 1, retainedBy: { mainView: 1 } }
  const list: SessionListState = {
    ids: [SESSION_ID],
    byId: {
      [SESSION_ID]: {
        id: SESSION_ID,
        displayTitle: 'Composition fixture',
        running: false,
        retainedBy: retained.retainedBy,
        blank: false,
        updatedAt: 0,
      },
    },
    phase: 'ready',
    projectionsBySession: {},
  }
  const source = <T,>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} })
  const sessions = new Proxy({
    list: source(list),
    retain: () => reference,
    retainInfo: () => source(retained),
    binding: (id: SessionId) => id === SESSION_ID ? binding : undefined,
    scope: (id: SessionId) => id === SESSION_ID ? scope.ctx : undefined,
    scopeOf: (candidate: Context) => candidate === scope.ctx ? SESSION_ID : undefined,
    sessionOf: (candidate: Context) => candidate === scope.ctx ? session : undefined,
  }, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver)
      if (typeof property === 'symbol') return undefined
      throw new Error(`Unexpected Session fixture operation: ${String(property)}`)
    },
  }) as unknown as ISessions
  return { sessions, reference, eventSource }
}

function configForm() {
  let value: EnhancerSettings = {
    historyEnabled: true,
    optimizeEnabled: true,
    predictEnabled: true,
    rollbackEnabled: false,
    contextInspectEnabled: true,
    optimizeProvider: '',
    optimizeModel: '',
    optimizeReasoningEffort: '',
    predictProvider: '',
    predictModel: '',
    predictReasoningEffort: '',
      compactProvider: '',
      compactModel: '',
      compactReasoningEffort: '',
  }
  const listeners = new Set<() => void>()
  const form: ConfigForm<EnhancerSettings> = {
    getSnapshot: () => ({
      status: 'ready', value, base: undefined, user: undefined, revision: 0, writable: true,
    }),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: async () => true,
    unset: async () => true,
    mutate: async () => true,
  }
  return {
    form,
    listeners,
    accept(next: Partial<EnhancerSettings>) {
      value = { ...value, ...next }
      for (const listener of listeners) listener()
    },
  }
}

it('loads through the official Loader without replacing the composer bar and cleans up on unload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-enhancer-composition-'))
  const ctx = new Context()
  vi.spyOn(ctx.logger, 'error').mockImplementation(console.error)
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  })
  const modules = installClientModules()
  const sessionController = modules.require('@deepseek-ai/dsh-api-session-controller/client') as
    typeof import('@deepseek-ai/dsh-api-session-controller/client')
  const { sessions, reference, eventSource } = fixtureSessions(ctx, sessionController)
  const settings = configForm()
  const form = settings.form
  let resolveInventory!: (result: {
    ok: true
    value: { entries: readonly { moduleName: string; enabled: boolean }[] }
  }) => void
  const inventory = new Promise<Parameters<typeof resolveInventory>[0]>(resolve => { resolveInventory = resolve })
  const unmountRemote = vi.fn()
  const remote = {
    $on: vi.fn(() => () => {}),
    $mount: vi.fn(async () => {
      ctx.provide('remote.agentEnhancer', { call: vi.fn() } as never)
      ctx.provide('remote.checkpointRollback', remote.checkpointRollback as never)
      return unmountRemote
    }),
    $host: {},
    session: {},
    pluginInventory: { list: vi.fn(() => inventory) },
    checkpointRollback: { preview: vi.fn(), execute: vi.fn() },
  }
  const allowed = { getSnapshot: () => true, subscribe: () => () => {} }
  const failWorkspace = (operation: string) => () => {
    throw new Error(`Unexpected Workspace fixture operation: ${operation}`)
  }
  const uiWorkspace = new Proxy({}, {
    get: (_target, property) => failWorkspace(String(property)),
  }) as UiWorkspace
  let unmount: (() => void) | undefined
  let disposeRoot: (() => void) | undefined
  const container = document.createElement('div')
  document.body.append(container)
  try {
    ctx.provide('sessions', sessions)
    ctx.provide('remote', remote as never)
    ctx.provide('remote.session', remote.session as never)
    ctx.provide('remote.pluginInventory', remote.pluginInventory as never)
    ctx.provide('configForms', {
      get: () => form,
      whileServed: () => () => {},
      developerTools: { enabled: { getSnapshot: () => false, subscribe: () => () => {} } },
    } as unknown as ConfigForms)
    ctx.provide('remoteAccess', { source: () => allowed } as never)
    ctx.provide('fileUpload', { upload: async () => { throw new Error('Unexpected file upload') } } as never)
    ctx.provide('sidebarRight', { openResource: vi.fn(), openTab: vi.fn() } as never)
    ctx.provide('sidebarRightTabs', { register: vi.fn(() => () => {}) } as never)
    ctx.provide('uiWorkspace', uiWorkspace)

    const entries = [
      ['renderer', '@deepseek-ai/dsh-client-ui-renderer/client'],
      ['locale', '@deepseek-ai/dsh-client-locale/client'],
      ['session', '@deepseek-ai/dsh-client-ui-session/client'],
      ['conversation', '@deepseek-ai/dsh-client-ui-conversation/client'],
      ['chat', '@deepseek-ai/dsh-client-ui-chat/client'],
    ] as const
    const config = join(directory, 'cordis.yml')
    await writeFile(config, entries.map(([id, specifier]) =>
      `- id: ${id}\n  name: ${JSON.stringify(pathToFileURL(require.resolve(specifier)).href)}`,
    ).join('\n') + '\n')
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(directory + '/').href })
    const loader = ctx.loader
    const internal = {
      import: (specifier: string) => modules.import(specifier, async id => {
        loader.internal = undefined as never
        try {
          return await loader.import(`${id}?dsh-composition`)
        } finally {
          loader.internal = internal as never
        }
      }),
    }
    loader.internal = internal as never
    const renderer = await loader.import(pathToFileURL(require.resolve(entries[0][1])).href)
    expect(renderer).toHaveProperty('apply')
    await ctx.plugin(Include, { path: pathToFileURL(config).href })
    await vi.waitFor(() => {
      expect(ctx.get('slots')).toBeDefined()
      expect(ctx.get('uiSession')).toBeDefined()
      expect(ctx.get('uiConversation')).toBeDefined()
    })
    await ctx.loader.await()
    ctx.effect(() => ctx.slots.provideRoot({
      hooks: {
        workspaces: {
          getSnapshot: () => WORKSPACES,
          subscribe: () => () => {},
        },
      },
    }))

    function TestRoot({ renderSlot }: {
      renderSlot: (
        key: 'main',
        owner: object,
        opts: { entryKey: 'conversation' },
      ) => ReactNode
    }) {
      return renderSlot('main', {}, { entryKey: 'conversation' })
    }
    disposeRoot = ctx.slots.register({
      name: 'root',
      children: {
        main: { kind: 'keyed', scope: 'root' },
        'settings.plugins.tab': { kind: 'list', scope: 'root' },
      },
    }, TestRoot)
    await vi.waitFor(() => {
      expect(ctx.slots.entries('conversation.composer.bar')).toHaveLength(1)
    })
    await act(async () => {
      unmount = ctx.uiRenderer.mount(container)
    })
    await act(async () => { await reference.ready })

    const officialBar = ctx.slots.entries('conversation.composer.bar')[0]
    expect(officialBar).toBeDefined()
    expect(container.querySelector('[data-composer-input]')).not.toBeNull()
    expect(ctx.slots.entries('conversation.input.right')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.input.overlay')).toHaveLength(0)

    const baselineSettingsListeners = settings.listeners.size
    const enhancer = pathToFileURL(join(process.cwd(), 'lib/client.js')).href
    let enhancerId = ''
    await act(async () => {
      enhancerId = await ctx.loader.create({ name: enhancer })
      await ctx.loader.await()
    })

    for (const key of ['conversation.input.right', 'conversation.input.overlay'] as const) {
      expect(ctx.slots.entries(key).map(entry => ({
        id: entry.options.id,
        order: entry.options.order,
      }))).toEqual([{ id: 'agent-enhancer', order: 120 }])
    }
    expect(ctx.slots.entries('conversation.composer.bar')[0]).toBe(officialBar)
    expect(ctx.slots.entries('settings.plugins.tab').map(entry => entry.options.id)).toContain('agent-enhancer')
    expect(ctx.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
    expect(rollbackUserNodeEntries(ctx)).toHaveLength(0)
    act(() => { settings.accept({ rollbackEnabled: true }) })
    await vi.waitFor(() => {
      expect(rollbackUserNodeEntries(ctx)).toHaveLength(1)
    })
    act(() => { settings.accept({ rollbackEnabled: false }) })
    expect(rollbackUserNodeEntries(ctx)).toHaveLength(0)
    act(() => { settings.accept({ rollbackEnabled: true }) })
    await vi.waitFor(() => {
      expect(rollbackUserNodeEntries(ctx)).toHaveLength(1)
    })
    expect(settings.listeners.size).toBeGreaterThan(baselineSettingsListeners)
    expect(document.querySelector('style[data-dsh-agent-enhancer]')).not.toBeNull()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-agent-enhancer-overlay]')).not.toBeNull()
    })

    const input = container.querySelector<HTMLElement>('[data-composer-input]')
    expect(input).not.toBeNull()
    expect(fireEvent.keyDown(input!, { key: 'ArrowUp', code: 'ArrowUp', bubbles: true })).toBe(false)

    await act(async () => {
      eventSource.append({
        type: 'event',
        event: {
          seq: 1 as SessionSeq,
          time: 1,
          type: 'user/message',
          surfaceOp: 'append',
          data: {
            id: 'message-1' as MessageId,
            role: 'user',
            content: [{ type: 'text', text: 'fresh history' }],
            source: { kind: 'user' },
          },
        },
      })
    })
    await vi.waitFor(() => {
      expect(container.textContent).toContain('fresh history')
    })
    expect(fireEvent.keyDown(input!, { key: 'ArrowUp', code: 'ArrowUp', bubbles: true })).toBe(false)
    await vi.waitFor(() => {
      expect(input!.textContent).toBe('fresh history')
    })

    act(() => { settings.accept({ historyEnabled: false }) })
    expect(fireEvent.keyDown(input!, { key: 'ArrowUp', code: 'ArrowUp', bubbles: true })).toBe(true)
    expect(fireEvent.keyDown(input!, { key: 'r', code: 'KeyR', ctrlKey: true, bubbles: true })).toBe(true)
    expect(input!.textContent).toBe('fresh history')
    act(() => { settings.accept({ historyEnabled: true }) })
    expect(fireEvent.keyDown(input!, { key: 'ArrowUp', code: 'ArrowUp', bubbles: true })).toBe(false)
    await vi.waitFor(() => { expect(input!.textContent).toBe('fresh history') })

    await act(async () => {
      await ctx.loader.remove(enhancerId)
      await ctx.loader.await()
    })
    expect(ctx.slots.entries('conversation.input.right')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.input.overlay')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
    expect(ctx.slots.entries('settings.plugins.tab').map(entry => entry.options.id)).not.toContain('agent-enhancer')
    expect(ctx.slots.entries('conversation.composer.bar')[0]).toBe(officialBar)
    await vi.waitFor(() => { expect(settings.listeners.size).toBe(baselineSettingsListeners) })
    expect(document.querySelector('style[data-dsh-agent-enhancer]')).toBeNull()
    const remaining = container.querySelector<HTMLElement>('[data-composer-input]')
    expect(remaining).not.toBeNull()
    expect(fireEvent.keyDown(remaining!, { key: 'ArrowUp', code: 'ArrowUp', bubbles: true })).toBe(true)
    expect(unmountRemote).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveInventory({ ok: true, value: { entries: [{ moduleName: 'dsh-input-assistant', enabled: true }] } })
      await inventory
    })
    expect(container.querySelector('[data-agent-enhancer-hint]')).toBeNull()
  } finally {
    if (unmount !== undefined) act(() => { unmount?.() })
    disposeRoot?.()
    reference.release()
    await ctx.fiber.dispose()
    modules.restore()
    container.remove()
    await rm(directory, { recursive: true, force: true })
    vi.unstubAllGlobals()
  }
}, 30_000)
