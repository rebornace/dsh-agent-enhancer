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
import { ComposerSession } from './composer/session.ts'
import type { ModuleSwitches } from './composer/types.ts'
import { ComposerControls } from './dsh/controls.tsx'
import { ComposerOverlay } from './dsh/overlay.tsx'
import { OverlapHintStore } from './dsh/plugin-hints.ts'
import {
  catalogLoadersFromRemote,
  loadDesktopModelCatalog,
} from './dsh/model-catalog.ts'
import type { ModelCatalogLoaders } from './dsh/model-catalog.ts'
import { AcceptedSettingsForm } from './dsh/settings-form.ts'
import { PluginSettings } from './dsh/settings.tsx'
import { composerLocales } from './locales.ts'
import { clientRemoteInfo, composerEnhancerCall } from './remote.ts'
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
// wired after $mount from the nested composerEnhancer fiber (root cannot inject it early).
export const inject = ['remote', 'remote.session', 'remote.pluginInventory', 'configForms', 'locale', 'slots']

export function apply(ctx: Context): void {
  ctx.effect(installCss)
  ctx.effect(() => ctx.locale.register('composer-enhancer', composerLocales))
  const t = ctx.locale.bind('composer-enhancer')
  const form = new AcceptedSettingsForm(ctx.configForms.get<EnhancerSettings>('composer-enhancer'))
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
    name: 'settings.plugins.tab', id: 'composer-enhancer', order: 120,
    label: () => t('settingsTitle'), locale: 'composer-enhancer',
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

  const applyComposerMounted = (mountedCtx: Context) => {
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
      return composerEnhancerCall.invoke(mountedCtx.remote, {
        payload: { method: 'generate', data },
      }, signal)
    }
    const sessions = new Map<SessionId, ComposerSession>()
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
        session = new ComposerSession(switches, generate, generate)
        sessions.set(sessionId, session)
      }
      return session
    }
    mountedCtx.slots.inject('conversation.input.right', () => mountedCtx.slots.register({
      name: 'conversation.input.right', id: 'composer-enhancer', order: 120,
      locale: 'composer-enhancer',
      inject: sessionId => ({ session: sessionFor(sessionId) }),
    }, ComposerControls))
    mountedCtx.slots.inject('conversation.input.overlay', () => mountedCtx.slots.register({
      name: 'conversation.input.overlay', id: 'composer-enhancer', order: 120,
      locale: 'composer-enhancer',
      inject: sessionId => ({ session: sessionFor(sessionId), hints }),
    }, ComposerOverlay))
  }

  const applyRollbackMounted = (mountedCtx: Context) => {
    const rollbackRemote: RollbackRemote = {
      preview: (request, signal) => checkpointRollbackRemote.preview(mountedCtx.remote, request, signal),
      execute: (request, signal) => checkpointRollbackRemote.execute(mountedCtx.remote, request, signal),
    }
    const rollbackSessions = new Map<SessionId, RollbackController>()
    const rollbackRetentions = new Map<SessionId, () => void>()
    const undoTips = new RollbackUndoTipStore()
    const tEnhancer = mountedCtx.locale.bind('composer-enhancer')
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
            registrant: 'composer-enhancer-rollback-user',
          }, rollbackUserNode as never)))
          // Keep the confirm dialog outside chat nodes so surface replace cannot tear it down.
          disposers.push(mountedCtx.slots.inject('conversation.input.overlay', () => mountedCtx.slots.register({
            name: 'conversation.input.overlay', id: 'composer-enhancer-rollback', order: 121,
            locale: 'composer-enhancer',
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
    const composerFiber = await ctx.plugin({
      name: 'composer-enhancer-mounted',
      inject: ['remote.composerEnhancer'],
      apply: (mountedCtx: Context) => {
        adoptCatalogLoaders(mountedCtx.remote)
        applyComposerMounted(mountedCtx)
      },
    })
    const rollbackFiber = await ctx.plugin({
      name: 'composer-enhancer-rollback-mounted',
      inject: ['remote.checkpointRollback'],
      apply: applyRollbackMounted,
    })
    return async () => {
      await rollbackFiber.dispose()
      await composerFiber.dispose()
      await unmount()
    }
  })
}
