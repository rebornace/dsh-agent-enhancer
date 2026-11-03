import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import type { ClientRemote, PluginInventorySnapshot, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { resolveSettings } from '../config.ts'
import type { EnhancerSettings } from '../config.ts'
import { resolveUiLocale } from '../host/prompts.ts'
import type { AuxiliaryRequest, AuxiliaryResult, UiLocale } from '../host/types.ts'
import { PromptSession } from './prompt/session.ts'
import type { ModuleSwitches } from './prompt/types.ts'
import { AgentControls } from './dsh/controls.tsx'
import { AgentOverlay } from './dsh/overlay.tsx'
import { OverlapHintStore } from './dsh/plugin-hints.ts'
import {
  catalogLoadersFromRemote,
  loadDesktopModelCatalog,
} from './dsh/model-catalog.ts'
import type { ModelCatalogLoaders } from './dsh/model-catalog.ts'
import { AcceptedSettingsForm } from './dsh/settings-form.ts'
import { PluginSettings } from './dsh/settings.tsx'
import { agentLocales } from './locales.ts'
import { clientRemoteInfo, agentEnhancerCall } from './remote.ts'
import { RollbackController } from './rollback/controller.ts'
import type { RollbackRemote } from './rollback/controller.ts'
import { RollbackModalHost } from './rollback/modal-host.tsx'
import { checkpointRollbackRemote } from './rollback/remote.ts'
import { installRollbackUndoCommand } from './rollback/command-ui.ts'
import { installRollbackTranscriptFilter } from './rollback/transcript-filter.ts'
import { installRollbackTurnOutlineFilter } from './rollback/turn-outline-filter.ts'
import { RollbackUndoTipStore } from './rollback/undo-tip.ts'
import { RollbackUserNode } from './rollback/user-node.tsx'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { installCss } from './styles.module.css'

type InventoryRemote = ClientRemote & {
  readonly pluginInventory: {
    list(): Promise<RemoteResult<PluginInventorySnapshot>>
  }
}

// session.modelCatalog needs remote.session on this fiber. Host listCatalog is
// wired after $mount from the nested agentEnhancer fiber (root cannot inject it early).
export const inject = ['remote', 'remote.session', 'remote.pluginInventory', 'configForms', 'locale', 'slots']

export function apply(ctx: Context): void {
  ctx.effect(installCss)
  ctx.effect(() => ctx.locale.register('agent-enhancer', agentLocales))
  const t = ctx.locale.bind('agent-enhancer')
  const form = new AcceptedSettingsForm(ctx.configForms.get<EnhancerSettings>('agent-enhancer'))
  const catalogLoaders: {
    sessionModelCatalog?: ModelCatalogLoaders['sessionModelCatalog']
    hostListCatalog?: ModelCatalogLoaders['hostListCatalog']
  } = { ...catalogLoadersFromRemote(ctx.remote) }
  const adoptCatalogLoaders = (remote: unknown) => {
    const next = catalogLoadersFromRemote(remote)
    if (next.sessionModelCatalog) catalogLoaders.sessionModelCatalog = next.sessionModelCatalog
    if (next.hostListCatalog) catalogLoaders.hostListCatalog = next.hostListCatalog
  }
  // Register settings immediately — never wait on Remote $mount, or the tab stays empty.
  // Keep inject props to `{ form }` only (slot host pattern); close over catalog loader.
  const loadCatalog = () => Promise.resolve().then(
    () => loadDesktopModelCatalog(catalogLoaders),
  )
  const SettingsTab = (props: { readonly form: typeof form; readonly t: typeof t }) => (
    createElement(PluginSettings, { form: props.form, t: props.t, loadCatalog })
  )
  ctx.effect(() => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab', id: 'agent-enhancer', order: 120,
    label: () => t('settingsTitle'), locale: 'agent-enhancer',
    inject: () => ({ form }),
  }, SettingsTab)))
  const hints = new OverlapHintStore()
  ctx.effect(() => {
    let active = true
    const load = async () => {
      try {
        const result = await (ctx.remote as InventoryRemote).pluginInventory.list()
        if (active && result.ok) hints.accept(result.value.entries)
      } catch {}
    }
    void load()
    return () => {
      active = false
      hints.dispose()
    }
  })

  const applyAgentMounted = (mountedCtx: Context) => {
    const switches: ModuleSwitches = {
      history: () => resolveSettings(form.getSnapshot().value).historyEnabled,
      optimize: () => resolveSettings(form.getSnapshot().value).optimizeEnabled,
      predict: () => resolveSettings(form.getSnapshot().value).predictEnabled,
    }
    const desktopUiLocale = (): UiLocale => {
      try {
        return resolveUiLocale(mountedCtx.locale.getLocale().active)
      } catch {
        return 'zh'
      }
    }
    const generate = async (request: AuxiliaryRequest, signal: AbortSignal): Promise<AuxiliaryResult | null> => {
      const uiLocale = request.uiLocale ?? desktopUiLocale()
      const data = request.operation === 'optimize'
        ? { ...request, references: [...request.references], context: [...request.context], uiLocale }
        : { ...request, context: [...request.context], uiLocale }
      return agentEnhancerCall.invoke(mountedCtx.remote, {
        payload: { method: 'generate', data },
      }, signal)
    }
    const sessions = new Map<SessionId, PromptSession>()
    mountedCtx.effect(() => form.subscribe(() => {
      for (const session of sessions.values()) session.refreshSettings()
    }))
    mountedCtx.effect(() => () => {
      for (const session of sessions.values()) session.dispose()
      sessions.clear()
    })
    const sessionFor = (sessionId: SessionId) => {
      let session = sessions.get(sessionId)
      if (session === undefined) {
        session = new PromptSession(switches, generate, generate)
        sessions.set(sessionId, session)
      }
      return session
    }
    mountedCtx.slots.inject('conversation.input.right', () => mountedCtx.slots.register({
      name: 'conversation.input.right', id: 'agent-enhancer', order: 120,
      locale: 'agent-enhancer',
      inject: sessionId => ({ session: sessionFor(sessionId) }),
    }, AgentControls))
    mountedCtx.slots.inject('conversation.input.overlay', () => mountedCtx.slots.register({
      name: 'conversation.input.overlay', id: 'agent-enhancer', order: 120,
      locale: 'agent-enhancer',
      inject: sessionId => ({ session: sessionFor(sessionId), hints }),
    }, AgentOverlay))
  }

  const applyRollbackMounted = (mountedCtx: Context) => {
    const rollbackRemote: RollbackRemote = {
      preview: (request, signal) => checkpointRollbackRemote.preview(mountedCtx.remote, request, signal),
      execute: (request, signal) => checkpointRollbackRemote.execute(mountedCtx.remote, request, signal),
    }
    const rollbackSessions = new Map<SessionId, RollbackController>()
    const rollbackRetentions = new Map<SessionId, () => void>()
    const undoTips = new RollbackUndoTipStore()
    const tEnhancer = mountedCtx.locale.bind('agent-enhancer')
    const tChat = mountedCtx.locale.bind('chat')
    const rollbackEnabled = () => resolveSettings(form.getSnapshot().value).rollbackEnabled
    const rollbackFor = (sessionId: SessionId) => {
      let rollback = rollbackSessions.get(sessionId)
      if (rollback === undefined) {
        rollback = new RollbackController({
          sessionId,
          enabled: rollbackEnabled,
          remote: rollbackRemote,
        })
        rollbackSessions.set(sessionId, rollback)
        const sessions = mountedCtx.get('sessions')
        if (sessions !== undefined) {
          const retention = sessions.retainInfo(sessionId)
          rollbackRetentions.set(sessionId, retention.subscribe(() => {
            if ((retention.getSnapshot().retainedBy.mainView ?? 0) === 0) {
              rollbackSessions.get(sessionId)?.close()
            }
          }))
        }
      }
      return rollback
    }
    const rollbackUserNode = (props: ChatNodeViewProps<'user'>) => createElement(
      RollbackUserNode,
      { ...props, rollback: rollbackFor(props.sessionId), tEnhancer, tChat },
    )
    const rollbackOverlay = (props: PropsRuntime<'conversation.input.overlay'>) => createElement(
      RollbackModalHost,
      { rollback: rollbackFor(props.sessionId), t: tEnhancer, inputActions: props.inputActions },
    )
    const disposers: Array<() => void> = []
    const disableRollback = () => {
      while (disposers.length > 0) disposers.pop()?.()
      for (const rollback of rollbackSessions.values()) rollback.dispose()
      for (const unsubscribe of rollbackRetentions.values()) unsubscribe()
      rollbackSessions.clear()
      rollbackRetentions.clear()
      undoTips.clear()
    }
    mountedCtx.effect(() => {
      const synchronize = () => {
        const enabled = rollbackEnabled()
        if (!enabled) {
          disableRollback()
        } else if (disposers.length === 0) {
          disposers.push(mountedCtx.slots.inject('conversation.chat.node', () => mountedCtx.slots.register({
            name: 'conversation.chat.node', key: 'user', priority: -120,
            registrant: 'agent-enhancer-rollback-user',
          }, rollbackUserNode as never)))
          // Keep the confirm dialog outside chat nodes so surface replace cannot tear it down.
          disposers.push(mountedCtx.slots.inject('conversation.input.overlay', () => mountedCtx.slots.register({
            name: 'conversation.input.overlay', id: 'agent-enhancer-rollback', order: 121,
            locale: 'agent-enhancer',
          }, rollbackOverlay as never)))
          // Chat only renders append-origin events; reshape the loaded window so
          // surface-replaced history disappears and the rollback tip becomes visible.
          disposers.push(installRollbackTranscriptFilter(mountedCtx, undoTips))
          // Host turnOutline keeps every turn; filter it so TurnNavigator drops rolled-back marks.
          disposers.push(installRollbackTurnOutlineFilter(mountedCtx))
          // + button and `/` share this menu; show undo only while a restore tip remains.
          disposers.push(installRollbackUndoCommand({
            ctx: mountedCtx,
            tips: undoTips,
            rollbackFor,
            enabled: rollbackEnabled,
            t: tEnhancer,
          }))
        }
      }
      const unsubscribe = form.subscribe(synchronize)
      synchronize()
      return () => {
        unsubscribe()
        disableRollback()
      }
    })
  }

  ctx.effect(async () => {
    const unmount = await ctx.remote.$mount(clientRemoteInfo)
    const agentFiber = await ctx.plugin({
      name: 'agent-enhancer-mounted',
      inject: ['remote.agentEnhancer'],
      apply: (mountedCtx: Context) => {
        adoptCatalogLoaders(mountedCtx.remote)
        applyAgentMounted(mountedCtx)
      },
    })
    const rollbackFiber = await ctx.plugin({
      name: 'agent-enhancer-rollback-mounted',
      inject: ['remote.checkpointRollback'],
      apply: applyRollbackMounted,
    })
    return async () => {
      await rollbackFiber.dispose()
      await agentFiber.dispose()
      await unmount()
    }
  })
}
