import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import type { ClientRemote, PluginInventorySnapshot, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { resolveSettings } from '../config.ts'
import type { EnhancerSettings } from '../config.ts'
import { resolveUiLocale } from '../host/prompts.ts'
import type { AuxiliaryRequest, AuxiliaryResult, UiLocale } from '../host/types.ts'
import type { ProviderBalanceSource, UsageRange } from '../host/usage/types.ts'
import {
  PROVIDER_BALANCE_ACCOUNT_KEY,
  PROVIDER_BALANCE_API_KEY_KEY,
} from '../host/usage/balance.ts'
import { disposePromptLedger } from './prompt/ledger-store.ts'
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
import {
  persistEnhancerSettings,
  withSettingsRemote,
} from './dsh/persist-settings.ts'
import type { SettingsPersistOp } from './dsh/persist-settings.ts'
import { AcceptedSettingsForm } from './dsh/settings-form.ts'
import { PluginSettings } from './dsh/settings.tsx'
import { ContextInspectDock } from './context/dock.tsx'
import { openCheckpointTimelineTab, openContextInspectTab, openUsageTab } from './context/open-tab.ts'
import { ContextInspectRightTab, ContextInspectRightTabTitle } from './context/right-tab.tsx'
import { CONTEXT_INSPECT_TAB_ID, CONTEXT_INSPECT_TAB_KIND } from './context/tab.ts'
import { UsageMeterDock } from './dsh/usage-dock.tsx'
import { UsageRightTab, UsageRightTabTitle } from './dsh/usage-tab.tsx'
import { USAGE_TAB_ID, USAGE_TAB_KIND } from './dsh/usage-kind.ts'
import type { ContextInspectCategory } from '../host/context-inspect.ts'
import { agentLocales } from './locales.ts'
import {
  agentEnhancerApplyUpdate,
  agentEnhancerCall,
  agentEnhancerCheckUpdate,
  agentEnhancerUsageSummary,
  agentEnhancerProviderBalances,
  agentEnhancerCompactContext,
  agentEnhancerInspectContext,
  agentEnhancerSoftPauseSet,
  agentEnhancerSoftPauseSnapshot,
  clientRemoteInfo,
} from './remote.ts'
import { installBrowserChatLinks } from './browser-agent/chat-links.ts'
import { BrowserAgentGuideIcon } from './browser-agent/guide-icon.tsx'
import {
  BROWSER_AGENT_TAB_ID,
  BROWSER_AGENT_TAB_KIND,
} from './browser-agent/kind.ts'
import { BrowserAgentOverlay } from './browser-agent/overlay.tsx'
import { BrowserAgentTab, BrowserAgentTabTitle } from './browser-agent/tab.tsx'
import { SoftPauseController } from './soft-pause/controller.ts'
import { ProviderBalanceChip } from './dsh/provider-balance-chip.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { RollbackController } from './rollback/controller.ts'
import type { RollbackRemote } from './rollback/controller.ts'
import { SessionCutCache } from './rollback/cut-cache.ts'
import { RollbackModalHost } from './rollback/modal-host.tsx'
import { checkpointRollbackRemote } from './rollback/remote.ts'
import { installRollbackUndoCommand } from './rollback/command-ui.ts'
import { installRollbackTranscriptFilter } from './rollback/transcript-filter.ts'
import { installRollbackTurnOutlineFilter } from './rollback/turn-outline-filter.ts'
import { installRollbackSessionStatsFilter } from './rollback/session-stats-filter.ts'
import { RollbackUndoTipStore } from './rollback/undo-tip.ts'
import { RollbackUserNode } from './rollback/user-node.tsx'
import {
  CHECKPOINT_TIMELINE_TAB_ID,
  CHECKPOINT_TIMELINE_TAB_KIND,
} from './rollback/timeline-kind.ts'
import { SessionStatsCheckpointDock } from './rollback/session-stats-dock.tsx'
import {
  CheckpointTimelineTab,
  CheckpointTimelineTabTitle,
  type CheckpointTimelineTabProps,
} from './rollback/timeline-tab.tsx'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { QuoteExternalHosts } from './quote/external-hosts.tsx'
import { SessionDeleteMenuItem } from './session-delete/menu.tsx'
import { SessionDeleteOverlay } from './session-delete/overlay.tsx'
import { RunAlertsHost } from './run-alerts/host.tsx'
import { basenameOfPath, parseWorkspaceFileAddress } from './file-edit/address.ts'
import { FileEditDocumentAction } from './file-edit/action.tsx'
import { FILE_EDIT_TAB_ID, FILE_EDIT_TAB_KIND } from './file-edit/kind.ts'
import { FileEditTab, FileEditTabTitle } from './file-edit/tab.tsx'
import './file-edit/slot-types.ts'
import { ExtraFoldersGuideIcon } from './extra-folders/guide-icon.tsx'
import {
  EXTRA_FOLDERS_TAB_ID,
  EXTRA_FOLDERS_TAB_KIND,
} from './extra-folders/kind.ts'
import { ExtraFoldersTab, ExtraFoldersTabTitle } from './extra-folders/tab.tsx'
import { installInstructionsSkillsLeftNav } from './instructions-skills/left-nav.ts'
import { installMcpConnectorsLeftNav } from './mcp-connectors/left-nav.ts'
import { installWebChatBridgeLeftNav } from './web-chat-bridge/left-nav.ts'
import { installCss } from './styles.module.css'

type InventoryRemote = ClientRemote & {
  readonly pluginInventory: {
    list(): Promise<RemoteResult<PluginInventorySnapshot>>
  }
}

// session.modelCatalog needs remote.session on this fiber. Host listCatalog is
// wired after $mount from the nested agentEnhancer fiber (root cannot inject it early).
export const inject = [
  // Do not hard-inject remote.settings: that delays this client fiber until the
  // settings controller is up and has been observed to slow Desktop account
  // paint. Persist probes settings softly at save time instead.
  'remote', 'remote.session', 'remote.pluginInventory', 'configForms', 'locale', 'slots',
  'sidebarRightTabs', 'sidebarRight',
]

export function apply(ctx: Context): void {
  ctx.effect(installCss)
  ctx.effect(() => ctx.locale.register('agent-enhancer', agentLocales))
  const t = ctx.locale.bind('agent-enhancer')
  const form = new AcceptedSettingsForm(ctx.configForms.get<EnhancerSettings>('agent-enhancer'))
  const catalogLoaders: {
    sessionModelCatalog?: ModelCatalogLoaders['sessionModelCatalog']
    hostListCatalog?: ModelCatalogLoaders['hostListCatalog']
  } = { ...catalogLoadersFromRemote(ctx.remote) }
  // agentEnhancer remotes only exist on the nested fiber after $mount — same as listCatalog.
  // Capture the face object at mount time; later settings clicks run on the root fiber where
  // `mountedCtx.remote.agentEnhancer` would fail Cordis inject checks.
  let agentEnhancerRemote: { readonly agentEnhancer: object } | undefined
  const agentRemoteWaiters: Array<(remote: { readonly agentEnhancer: object }) => void> = []
  const adoptCatalogLoaders = (remote: unknown) => {
    const next = catalogLoadersFromRemote(remote)
    if (next.sessionModelCatalog) catalogLoaders.sessionModelCatalog = next.sessionModelCatalog
    if (next.hostListCatalog) catalogLoaders.hostListCatalog = next.hostListCatalog
  }
  const readAgentEnhancerFace = (mountedCtx: Context): object | undefined => {
    try {
      const injected = Reflect.get(mountedCtx as object, 'remote.agentEnhancer')
      if (injected !== null && injected !== undefined && typeof injected === 'object') {
        return injected as object
      }
    } catch { /* root-style access */ }
    try {
      const nested = Reflect.get(mountedCtx.remote as object, 'agentEnhancer')
      if (nested !== null && nested !== undefined && typeof nested === 'object') {
        return nested as object
      }
    } catch { /* missing face */ }
    return undefined
  }
  const adoptAgentRemote = (mountedCtx: Context) => {
    adoptCatalogLoaders(mountedCtx.remote)
    const face = readAgentEnhancerFace(mountedCtx)
    if (face === undefined) return
    const remote = { agentEnhancer: face }
    agentEnhancerRemote = remote
    while (agentRemoteWaiters.length > 0) agentRemoteWaiters.shift()?.(remote)
  }
  const withAgentRemote = async <T>(
    run: (remote: { readonly agentEnhancer: object }) => Promise<T>,
  ): Promise<T> => {
    if (agentEnhancerRemote !== undefined) return run(agentEnhancerRemote)
    const remote = await new Promise<{ readonly agentEnhancer: object }>(resolve => {
      agentRemoteWaiters.push(resolve)
    })
    return run(remote)
  }
  // Register settings immediately — never wait on Remote $mount, or the tab stays empty.
  // Keep inject props to `{ form }` only (slot host pattern); close over catalog loader.
  const loadCatalog = () => Promise.resolve().then(
    () => loadDesktopModelCatalog(catalogLoaders),
  )
  const checkUpdate = () => withAgentRemote(remote => agentEnhancerCheckUpdate.invoke(remote))
  const applyUpdate = () => withAgentRemote(remote => agentEnhancerApplyUpdate.invoke(remote))
  const loadUsage = (range: UsageRange) => withAgentRemote(
    remote => agentEnhancerUsageSummary.invoke(remote, range),
  )
  const desktopLocale = (): string => {
    try {
      return ctx.locale.getLocale().active
    } catch {
      return 'zh-CN'
    }
  }
  const loadProviderSnapshot = (source: ProviderBalanceSource) => async (force = false) => {
    const all = await withAgentRemote(remote => agentEnhancerProviderBalances.invoke(remote, {
      force,
      locale: desktopLocale(),
    }))
    return source === 'account' ? all.account : all.apiKey
  }
  const persist = async (ops: readonly SettingsPersistOp[]) => {
    // Lazy-inject remote.settings only while saving — hard inject at boot slowed
    // Desktop account paint; soft probe without inject throws unavailable.
    await withSettingsRemote(ctx, remote => persistEnhancerSettings(
      remote,
      ops,
      () => form.getSnapshot().revision,
    ))
    form.acceptLocal(ops)
  }
  const SettingsTab = (props: { readonly form: typeof form; readonly t: typeof t }) => (
    createElement(PluginSettings, {
      form: props.form,
      t: props.t,
      persist,
      loadCatalog,
      checkUpdate,
      applyUpdate,
      getRemote: () => agentEnhancerRemote,
    })
  )
  ctx.effect(() => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab', id: 'agent-enhancer', order: 120,
    label: () => t('settingsTitle'), locale: 'agent-enhancer',
    inject: () => ({ form }),
  }, SettingsTab)))
  const AccountBalanceChip = () => createElement(ProviderBalanceChip, {
    source: 'account',
    t,
    load: loadProviderSnapshot('account'),
  })
  const ApiKeyBalanceChip = () => createElement(ProviderBalanceChip, {
    source: 'api-key',
    t,
    load: loadProviderSnapshot('api-key'),
  })
  ctx.effect(() => ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: PROVIDER_BALANCE_ACCOUNT_KEY,
  }, AccountBalanceChip)))
  ctx.effect(() => ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: PROVIDER_BALANCE_API_KEY_KEY,
  }, ApiKeyBalanceChip)))

  // Session delete: menu row + frame-wide confirm overlay (must outlive the menu).
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    const clear = () => {
      while (disposers.length > 0) disposers.pop()?.()
    }
    const synchronize = () => {
      clear()
      const enabled = resolveSettings(form.getSnapshot().value).sessionDeleteEnabled
      if (!enabled) return
      disposers.push(ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'agent-enhancer-session-delete',
        order: 700,
      }, (props: PropsRuntime<'sidebar.workspaces.session.menu.item'>) => createElement(SessionDeleteMenuItem, {
        ...props,
        t,
        ctx,
      }))))
      disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'agent-enhancer-session-delete',
        order: 160,
      }, () => createElement(SessionDeleteOverlay, {
        remote: agentEnhancerRemote,
        t,
        ctx,
      }))))
    }
    const unsubscribe = form.subscribe(synchronize)
    synchronize()
    return () => {
      unsubscribe()
      clear()
    }
  })

  // Run alerts: finish / pending / error when the user is not watching that session.
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    const clear = () => {
      while (disposers.length > 0) disposers.pop()?.()
    }
    const synchronize = () => {
      clear()
      const enabled = resolveSettings(form.getSnapshot().value).runAlertsEnabled
      if (!enabled) return
      disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'agent-enhancer-run-alerts',
        order: 165,
      }, (props: PropsRuntime<'shell.overlay'>) => createElement(RunAlertsHost, {
        ...props,
        t,
        ctx,
        getLevel: () => resolveSettings(form.getSnapshot().value).runAlertsLevel,
        getRemote: () => agentEnhancerRemote,
        browserAgentEnabled: () => resolveSettings(form.getSnapshot().value).browserAgentEnabled,
      }))))
    }
    const unsubscribe = form.subscribe(synchronize)
    synchronize()
    return () => {
      unsubscribe()
      clear()
    }
  })

  // Browser agent: approval / conflict / needsHuman overlays + chat Alt+click.
  // No launch dialog — Agent tools and Alt+click auto-launch the dedicated browser.
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    const clear = () => {
      while (disposers.length > 0) disposers.pop()?.()
    }
    const synchronize = () => {
      clear()
      const enabled = resolveSettings(form.getSnapshot().value).browserAgentEnabled
      if (!enabled) return
      disposers.push(installBrowserChatLinks({
        enabled: () => resolveSettings(form.getSnapshot().value).browserAgentEnabled,
        getRemote: () => agentEnhancerRemote,
      }))
      disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'agent-enhancer-browser-agent',
        order: 166,
      }, () => createElement(BrowserAgentOverlay, {
        t,
        getRemote: () => agentEnhancerRemote,
      }))))
    }
    const unsubscribe = form.subscribe(synchronize)
    synchronize()
    return () => {
      unsubscribe()
      clear()
    }
  })

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
      for (const sessionId of sessions.keys()) disposePromptLedger(sessionId)
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

    const tContext = mountedCtx.locale.bind('agent-enhancer')
    const quoteEnabled = () => resolveSettings(form.getSnapshot().value).quoteEnabled
    // Preview / editor / terminal quote only — chat uses official Desktop quote (0.2.2+).
    // Toggle tears the overlay host down; Monaco still reads quoteEnabled via file-edit.
    mountedCtx.effect(() => {
      const disposers: Array<() => void> = []
      const clear = () => {
        while (disposers.length > 0) disposers.pop()?.()
      }
      const synchronize = () => {
        if (!quoteEnabled()) {
          clear()
          return
        }
        if (disposers.length > 0) return
        disposers.push(mountedCtx.slots.inject('shell.overlay', () => mountedCtx.slots.register({
          name: 'shell.overlay',
          id: 'agent-enhancer-quote-hosts',
          order: 150,
          locale: 'agent-enhancer',
        }, () => createElement(QuoteExternalHosts, { t: tContext }))))
      }
      const unsubscribe = form.subscribe(synchronize)
      synchronize()
      return () => {
        unsubscribe()
        clear()
      }
    })

    const contextInspectEnabled = () => resolveSettings(form.getSnapshot().value).contextInspectEnabled
    const usageEnabled = () => resolveSettings(form.getSnapshot().value).usageEnabled
    const inspectContext = (
      sessionId: SessionId,
      category: ContextInspectCategory,
      signal: AbortSignal,
    ) => agentEnhancerInspectContext.invoke(mountedCtx.remote, { sessionId, category }, signal)
    const compactContext = (
      sessionId: SessionId,
      signal: AbortSignal,
    ) => agentEnhancerCompactContext.invoke(mountedCtx.remote, { sessionId }, signal)
    const ContextDock = (props: PropsRuntime<'conversation.composer.dock'>) => createElement(ContextInspectDock, {
      ...props,
      enabled: contextInspectEnabled,
      open: (category: ContextInspectCategory) => {
        openContextInspectTab(mountedCtx.sidebarRight, {
          sessionId: props.sessionId,
          category,
        })
      },
      t: tContext,
    })
    const BillDock = (props: PropsRuntime<'conversation.composer.dock'>) => createElement(UsageMeterDock, {
      ...props,
      open: () => {
        openUsageTab(mountedCtx.sidebarRight)
      },
      t: tContext,
    })
    const ContextRightTab = (props: PropsRuntime<'sidebar.right.pane.tab'>) => createElement(ContextInspectRightTab, {
      ...props,
      inspect: inspectContext,
      compact: compactContext,
      t: tContext,
    })
    const ContextRightTitle = (props: PropsRuntime<'sidebar.right.pane.tab.title'>) => createElement(
      ContextInspectRightTabTitle,
      { ...props, t: tContext },
    )
    const BillRightTab = (props: PropsRuntime<'sidebar.right.pane.tab'>) => createElement(UsageRightTab, {
      ...props,
      loadUsage,
      t: tContext,
    })
    const BillRightTitle = (props: PropsRuntime<'sidebar.right.pane.tab.title'>) => createElement(
      UsageRightTabTitle,
      { ...props, t: tContext },
    )
    const fileEditEnabled = () => resolveSettings(form.getSnapshot().value).fileEditEnabled
    const browserAgentEnabled = () => resolveSettings(form.getSnapshot().value).browserAgentEnabled
    const instructionsSkillsEnabled = () => resolveSettings(form.getSnapshot().value).instructionsSkillsEnabled
    const mcpConnectorsEnabled = () => resolveSettings(form.getSnapshot().value).mcpConnectorsEnabled
    const webChatBridgeEnabled = () => resolveSettings(form.getSnapshot().value).webChatBridgeEnabled
    const FileEditRightTab = (props: PropsRuntime<'sidebar.right.pane.tab'>) => createElement(FileEditTab, {
      ...props,
      remote: () => agentEnhancerRemote,
      sidebarRight: mountedCtx.sidebarRight,
      t: tContext,
      quoteEnabled,
    })
    const FileEditRightTitle = (props: PropsRuntime<'sidebar.right.pane.tab.title'>) => createElement(
      FileEditTabTitle,
      { ...props, t: tContext },
    )
    const FileEditAction = (props: PropsRuntime<'sidebar.right.tab.document.actions'>) => createElement(
      FileEditDocumentAction,
      {
        absolutePath: props.absolutePath,
        sessionId: props.sessionId,
        t: tContext,
        sidebarRight: mountedCtx.sidebarRight,
      },
    )
    const ExtraFoldersRightTab = (props: PropsRuntime<'sidebar.right.pane.tab'>) => createElement(
      ExtraFoldersTab,
      {
        ...props,
        remote: () => agentEnhancerRemote,
        sidebarRight: mountedCtx.sidebarRight,
        t: tContext,
      },
    )
    const ExtraFoldersRightTitle = (props: PropsRuntime<'sidebar.right.pane.tab.title'>) => createElement(
      ExtraFoldersTabTitle,
      { ...props, t: tContext },
    )
    const BrowserAgentRightTab = (props: PropsRuntime<'sidebar.right.pane.tab'>) => createElement(
      BrowserAgentTab,
      {
        ...props,
        remote: () => agentEnhancerRemote,
        browserPreference: () => resolveSettings(form.getSnapshot().value).browserAgentBrowser,
        persistBrowserPreference: browser => {
          void persist([{ op: 'set', path: ['browserAgentBrowser'], value: browser }])
        },
        t: tContext,
      },
    )
    const BrowserAgentRightTitle = (props: PropsRuntime<'sidebar.right.pane.tab.title'>) => createElement(
      BrowserAgentTabTitle,
      { ...props, t: tContext },
    )
    mountedCtx.effect(() => {
      const disposers: Array<() => void> = []
      const synchronize = () => {
        if (!usageEnabled()) {
          while (disposers.length > 0) disposers.pop()?.()
          return
        }
        if (disposers.length > 0) return
        disposers.push(mountedCtx.sidebarRightTabs.register({
          id: USAGE_TAB_ID,
          kind: USAGE_TAB_KIND,
          priority: 'extension',
          title: () => tContext('usageTitle'),
        }))
        disposers.push(mountedCtx.slots.inject('sidebar.right.pane.tab', () => mountedCtx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: USAGE_TAB_ID,
          locale: 'agent-enhancer',
        }, BillRightTab)))
        disposers.push(mountedCtx.slots.inject('sidebar.right.pane.tab.title', () => mountedCtx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: USAGE_TAB_ID,
          locale: 'agent-enhancer',
        }, BillRightTitle)))
        disposers.push(mountedCtx.slots.inject('conversation.composer.dock', () => mountedCtx.slots.register({
          name: 'conversation.composer.dock', id: 'agent-enhancer-usage', order: 40,
          locale: 'agent-enhancer',
        }, BillDock)))
      }
      const unsubscribe = form.subscribe(synchronize)
      synchronize()
      return () => {
        unsubscribe()
        while (disposers.length > 0) disposers.pop()?.()
      }
    })
    mountedCtx.effect(() => {
      const disposers: Array<() => void> = []
      const synchronize = () => {
        const enabled = contextInspectEnabled()
        if (!enabled) {
          while (disposers.length > 0) disposers.pop()?.()
          return
        }
        if (disposers.length > 0) return
        disposers.push(mountedCtx.sidebarRightTabs.register({
          id: CONTEXT_INSPECT_TAB_ID,
          kind: CONTEXT_INSPECT_TAB_KIND,
          priority: 'extension',
          title: () => tContext('contextInspectDetailTitle'),
        }))
        disposers.push(mountedCtx.slots.inject('sidebar.right.pane.tab', () => mountedCtx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: CONTEXT_INSPECT_TAB_ID,
          locale: 'agent-enhancer',
        }, ContextRightTab)))
        disposers.push(mountedCtx.slots.inject('sidebar.right.pane.tab.title', () => mountedCtx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: CONTEXT_INSPECT_TAB_ID,
          locale: 'agent-enhancer',
        }, ContextRightTitle)))
        disposers.push(mountedCtx.slots.inject('conversation.composer.dock', () => mountedCtx.slots.register({
          name: 'conversation.composer.dock', id: 'agent-enhancer-context', order: 50,
          locale: 'agent-enhancer',
        }, ContextDock)))
      }
      const unsubscribe = form.subscribe(synchronize)
      synchronize()
      return () => {
        unsubscribe()
        while (disposers.length > 0) disposers.pop()?.()
      }
    })
    mountedCtx.effect(() => {
      const disposers: Array<() => void> = []
      const synchronize = () => {
        const enabled = fileEditEnabled()
        if (!enabled) {
          while (disposers.length > 0) disposers.pop()?.()
          return
        }
        if (disposers.length > 0) return
        disposers.push(mountedCtx.sidebarRightTabs.register({
          id: FILE_EDIT_TAB_ID,
          kind: FILE_EDIT_TAB_KIND,
          // No patterns: default file opens stay on official preview. Forced
          // openResource(..., { kind }) still claims the file address.
          priority: 'extension',
          title: (address: string) => {
            const parsed = parseWorkspaceFileAddress(address)
            return parsed !== undefined ? basenameOfPath(parsed.path) : tContext('fileEditTitle')
          },
          canOpen: (address: string) => parseWorkspaceFileAddress(address) !== undefined,
        }))
        disposers.push(mountedCtx.slots.inject('sidebar.right.pane.tab', () => mountedCtx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: FILE_EDIT_TAB_ID,
          locale: 'agent-enhancer',
        }, FileEditRightTab)))
        disposers.push(mountedCtx.slots.inject('sidebar.right.pane.tab.title', () => mountedCtx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: FILE_EDIT_TAB_ID,
          locale: 'agent-enhancer',
        }, FileEditRightTitle)))
        disposers.push(mountedCtx.slots.inject('sidebar.right.tab.document.actions', () => mountedCtx.slots.register({
          name: 'sidebar.right.tab.document.actions',
          id: 'agent-enhancer-file-edit',
          order: 80,
          label: () => tContext('fileEdit'),
          locale: 'agent-enhancer',
        }, FileEditAction)))
        disposers.push(mountedCtx.sidebarRightTabs.register({
          id: EXTRA_FOLDERS_TAB_ID,
          kind: EXTRA_FOLDERS_TAB_KIND,
          priority: 'extension',
          title: () => tContext('extraFoldersTitle'),
          // Peer of 工作区文件 / 终端 / 浏览器 — use shipped EntryBox (do not
          // override sidebar.right.tab.guide.entry, or the capsule style drifts).
          guide: [{
            id: 'extra-folders',
            order: 35,
            title: () => tContext('extraFolders'),
            description: () => tContext('extraFoldersGuideDescription'),
            icon: ExtraFoldersGuideIcon,
          }],
        }))
        disposers.push(mountedCtx.slots.inject('sidebar.right.pane.tab', () => mountedCtx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: EXTRA_FOLDERS_TAB_ID,
          locale: 'agent-enhancer',
        }, ExtraFoldersRightTab)))
        disposers.push(mountedCtx.slots.inject('sidebar.right.pane.tab.title', () => mountedCtx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: EXTRA_FOLDERS_TAB_ID,
          locale: 'agent-enhancer',
        }, ExtraFoldersRightTitle)))
      }
      const unsubscribe = form.subscribe(synchronize)
      synchronize()
      return () => {
        unsubscribe()
        while (disposers.length > 0) disposers.pop()?.()
      }
    })
    mountedCtx.effect(() => {
      const disposers: Array<() => void> = []
      const synchronize = () => {
        const enabled = browserAgentEnabled()
        if (!enabled) {
          while (disposers.length > 0) disposers.pop()?.()
          return
        }
        if (disposers.length > 0) return
        disposers.push(mountedCtx.sidebarRightTabs.register({
          id: BROWSER_AGENT_TAB_ID,
          kind: BROWSER_AGENT_TAB_KIND,
          priority: 'extension',
          title: () => tContext('browserAgent'),
          // Peer of official 浏览器 guide capsule — EntryBox + GuideArtworkBrowser.
          guide: [{
            id: 'browser-agent',
            order: 36,
            title: () => tContext('browserAgent'),
            description: () => tContext('browserAgentGuideDescription'),
            icon: BrowserAgentGuideIcon,
          }],
        }))
        disposers.push(mountedCtx.slots.inject('sidebar.right.pane.tab', () => mountedCtx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: BROWSER_AGENT_TAB_ID,
          locale: 'agent-enhancer',
        }, BrowserAgentRightTab)))
        disposers.push(mountedCtx.slots.inject('sidebar.right.pane.tab.title', () => mountedCtx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: BROWSER_AGENT_TAB_ID,
          locale: 'agent-enhancer',
        }, BrowserAgentRightTitle)))
      }
      const unsubscribe = form.subscribe(synchronize)
      synchronize()
      return () => {
        unsubscribe()
        while (disposers.length > 0) disposers.pop()?.()
      }
    })
    mountedCtx.effect(() => {
      const nav = installInstructionsSkillsLeftNav(mountedCtx, {
        enabled: instructionsSkillsEnabled,
        t: tContext,
        remote: () => agentEnhancerRemote,
        sidebarRight: () => mountedCtx.sidebarRight,
      })
      const unsubscribe = form.subscribe(() => nav.synchronize())
      return () => {
        unsubscribe()
        nav.dispose()
      }
    })
    mountedCtx.effect(() => {
      const nav = installMcpConnectorsLeftNav(mountedCtx, {
        enabled: mcpConnectorsEnabled,
        t: tContext,
        remote: () => agentEnhancerRemote,
      })
      const unsubscribe = form.subscribe(() => nav.synchronize())
      return () => {
        unsubscribe()
        nav.dispose()
      }
    })
    mountedCtx.effect(() => {
      const nav = installWebChatBridgeLeftNav(mountedCtx, {
        enabled: webChatBridgeEnabled,
        t: tContext,
        remote: () => agentEnhancerRemote,
      })
      const unsubscribe = form.subscribe(() => nav.synchronize())
      return () => {
        unsubscribe()
        nav.dispose()
      }
    })
  }

  const applyRollbackMounted = (mountedCtx: Context) => {
    const rollbackRemote: RollbackRemote = {
      preview: (request, signal) => checkpointRollbackRemote.preview(mountedCtx.remote, request, signal),
      execute: (request, signal) => checkpointRollbackRemote.execute(mountedCtx.remote, request, signal),
      summaries: (request, signal) => checkpointRollbackRemote.summaries(mountedCtx.remote, request, signal),
      getCut: (request, signal) => checkpointRollbackRemote.getCut(mountedCtx.remote, request, signal),
    }
    const rollbackSessions = new Map<SessionId, RollbackController>()
    const rollbackRetentions = new Map<SessionId, () => void>()
    const undoTips = new RollbackUndoTipStore()
    const cutCache = new SessionCutCache()
    const refreshCut = async (sessionId: SessionId): Promise<void> => {
      const getCut = rollbackRemote.getCut
      if (getCut === undefined) return
      try {
        const result = await getCut({ sessionId }, new AbortController().signal)
        cutCache.set(sessionId, result.cut === null ? null : {
          hideTurnsFrom: result.cut.hideTurnsFrom,
          cutSeq: result.cut.cutSeq,
          restoredAtSeq: result.cut.restoredAtSeq,
        })
      } catch {
        // Keep the previous projection; the next summaries/execute will retry.
      }
    }
    const tEnhancer = mountedCtx.locale.bind('agent-enhancer')
    const tChat = mountedCtx.locale.bind('chat')
    const rollbackEnabled = () => resolveSettings(form.getSnapshot().value).rollbackEnabled
    const softPauseEnabled = () => resolveSettings(form.getSnapshot().value).softPauseEnabled
    const softPauseSessions = new Map<SessionId, SoftPauseController>()
    const softPauseRetentions = new Map<SessionId, () => void>()
    const softPauseFor = (sessionId: SessionId) => {
      let softPause = softPauseSessions.get(sessionId)
      if (softPause === undefined) {
        softPause = new SoftPauseController({
          sessionId,
          enabled: softPauseEnabled,
          remote: {
            snapshot: (id, signal) => withAgentRemote(
              remote => agentEnhancerSoftPauseSnapshot.invoke(remote, { sessionId: id }, signal),
            ),
            set: (id, engaged, signal) => withAgentRemote(
              remote => agentEnhancerSoftPauseSet.invoke(remote, { sessionId: id, engaged }, signal),
            ),
          },
        })
        softPauseSessions.set(sessionId, softPause)
        const sessions = mountedCtx.get('sessions')
        if (sessions !== undefined && !softPauseRetentions.has(sessionId)) {
          const retention = sessions.retainInfo(sessionId)
          softPauseRetentions.set(sessionId, retention.subscribe(() => {
            if ((retention.getSnapshot().retainedBy.mainView ?? 0) === 0) {
              softPauseSessions.get(sessionId)?.dispose()
              softPauseSessions.delete(sessionId)
              softPauseRetentions.get(sessionId)?.()
              softPauseRetentions.delete(sessionId)
            }
          }))
        }
      }
      return softPause
    }
    const disposeSoftPause = () => {
      for (const softPause of softPauseSessions.values()) softPause.dispose()
      softPauseSessions.clear()
      for (const unsubscribe of softPauseRetentions.values()) unsubscribe()
      softPauseRetentions.clear()
    }
    const rollbackFor = (sessionId: SessionId) => {
      let rollback = rollbackSessions.get(sessionId)
      if (rollback === undefined) {
        const remote: RollbackRemote = {
          ...rollbackRemote,
          async execute(request, signal) {
            const result = await rollbackRemote.execute(request, signal)
            // Await so undo clears the cut before the modal closes / chat re-projects.
            await refreshCut(sessionId)
            return result
          },
          async summaries(request, signal) {
            const summaries = rollbackRemote.summaries
            if (summaries === undefined) throw new Error('summaries unavailable')
            const result = await summaries(request, signal)
            void refreshCut(sessionId)
            return result
          },
        }
        rollback = new RollbackController({
          sessionId,
          enabled: rollbackEnabled,
          remote,
        })
        rollbackSessions.set(sessionId, rollback)
        void refreshCut(sessionId)
        const sessions = mountedCtx.get('sessions')
        if (sessions !== undefined) {
          const retention = sessions.retainInfo(sessionId)
          rollbackRetentions.set(sessionId, retention.subscribe(() => {
            if ((retention.getSnapshot().retainedBy.mainView ?? 0) === 0) {
              rollbackSessions.get(sessionId)?.close()
              cutCache.clear(sessionId)
              // Keep the prompt ledger for the session lifetime; only agent unmount clears it.
            }
          }))
        }
      }
      return rollback
    }
    const openTimeline = (sessionId: SessionId, turn?: number) => {
      openCheckpointTimelineTab(mountedCtx.sidebarRight, turn === undefined
        ? { sessionId }
        : { sessionId, turn })
    }
    const TimelineTab = (props: PropsRuntime<'sidebar.right.pane.tab'>) => createElement(
      CheckpointTimelineTab,
      {
        ...props,
        t: tEnhancer,
        remote: rollbackRemote,
        sessions: mountedCtx.get('sessions') as CheckpointTimelineTabProps['sessions'],
        rollbackFor,
        locale: resolveUiLocale(mountedCtx.locale.getLocale().active) === 'zh' ? 'zh-CN' : 'en',
      },
    )
    const TimelineTitle = (props: PropsRuntime<'sidebar.right.pane.tab.title'>) => createElement(
      CheckpointTimelineTabTitle,
      { ...props, t: tEnhancer },
    )
    const StatsCheckpointDock = (props: PropsRuntime<'conversation.composer.dock'>) => createElement(
      SessionStatsCheckpointDock,
      {
        ...props,
        enabled: rollbackEnabled,
        open: sessionId => { openTimeline(sessionId) },
        t: tEnhancer,
      },
    )
    const enhancerUserNode = (props: ChatNodeViewProps<'user'>) => createElement(
      RollbackUserNode,
      {
        ...props,
        rollback: rollbackEnabled() ? rollbackFor(props.sessionId) : undefined,
        softPause: softPauseEnabled() ? softPauseFor(props.sessionId) : undefined,
        tEnhancer,
        tChat,
        onOpenTimeline: rollbackEnabled()
          ? turn => { openTimeline(props.sessionId, turn) }
          : undefined,
      },
    )
    const rollbackOverlay = (props: PropsRuntime<'conversation.input.overlay'>) => createElement(
      RollbackModalHost,
      {
        rollback: rollbackFor(props.sessionId),
        t: tEnhancer,
        inputActions: props.inputActions,
        useSession: props.useSession,
        sessionId: props.sessionId,
        surface: 'composer',
        onOpenTimeline: turn => { openTimeline(props.sessionId, turn) },
      },
    )
    const userNodeDisposers: Array<() => void> = []
    const rollbackChromeDisposers: Array<() => void> = []
    const disableUserNode = () => {
      while (userNodeDisposers.length > 0) userNodeDisposers.pop()?.()
    }
    const disableRollbackChrome = () => {
      while (rollbackChromeDisposers.length > 0) rollbackChromeDisposers.pop()?.()
      for (const rollback of rollbackSessions.values()) rollback.dispose()
      for (const unsubscribe of rollbackRetentions.values()) unsubscribe()
      rollbackSessions.clear()
      rollbackRetentions.clear()
      undoTips.clear()
    }
    const disableAll = () => {
      disableUserNode()
      disableRollbackChrome()
      disposeSoftPause()
    }
    mountedCtx.effect(() => {
      const synchronize = () => {
        const rb = rollbackEnabled()
        const sp = softPauseEnabled()
        if (!sp) disposeSoftPause()
        else {
          for (const softPause of softPauseSessions.values()) softPause.refreshSettings()
        }
        if (rb || sp) {
          if (userNodeDisposers.length === 0) {
            userNodeDisposers.push(mountedCtx.slots.inject('conversation.chat.node', () => mountedCtx.slots.register({
              name: 'conversation.chat.node', key: 'user', priority: -120,
              registrant: 'agent-enhancer-user',
            }, enhancerUserNode as never)))
          }
        } else {
          disableUserNode()
        }
        if (rb) {
          if (rollbackChromeDisposers.length === 0) {
            rollbackChromeDisposers.push(mountedCtx.sidebarRightTabs.register({
              id: CHECKPOINT_TIMELINE_TAB_ID,
              kind: CHECKPOINT_TIMELINE_TAB_KIND,
              priority: 'extension',
              title: () => tEnhancer('rollbackTimelineTitle'),
            }))
            rollbackChromeDisposers.push(mountedCtx.slots.inject('sidebar.right.pane.tab', () => mountedCtx.slots.register({
              name: 'sidebar.right.pane.tab',
              key: CHECKPOINT_TIMELINE_TAB_ID,
              locale: 'agent-enhancer',
            }, TimelineTab)))
            rollbackChromeDisposers.push(mountedCtx.slots.inject('sidebar.right.pane.tab.title', () => mountedCtx.slots.register({
              name: 'sidebar.right.pane.tab.title',
              key: CHECKPOINT_TIMELINE_TAB_ID,
              locale: 'agent-enhancer',
            }, TimelineTitle)))
            // Keep the confirm dialog outside chat nodes so surface replace cannot tear it down.
            rollbackChromeDisposers.push(mountedCtx.slots.inject('conversation.input.overlay', () => mountedCtx.slots.register({
              name: 'conversation.input.overlay', id: 'agent-enhancer-rollback', order: 121,
              locale: 'agent-enhancer',
            }, rollbackOverlay as never)))
            // Session-stats title stays after a full rollback when per-message buttons are gone.
            rollbackChromeDisposers.push(mountedCtx.slots.inject('conversation.composer.dock', () => mountedCtx.slots.register({
              name: 'conversation.composer.dock', id: 'agent-enhancer-checkpoint-stats', order: 55,
              locale: 'agent-enhancer',
            }, StatsCheckpointDock)))
            // Chat only renders append-origin events; reshape the loaded window so
            // surface-replaced history disappears and the rollback tip becomes visible.
            rollbackChromeDisposers.push(installRollbackTranscriptFilter(mountedCtx, undoTips, cutCache))
            // Host turnOutline keeps every turn; filter it so TurnNavigator drops rolled-back marks.
            rollbackChromeDisposers.push(installRollbackTurnOutlineFilter(mountedCtx))
            // No-op: do not rewrite Host sessionStats (official pill / stats page own whole-log counts).
            rollbackChromeDisposers.push(installRollbackSessionStatsFilter(mountedCtx))
            // + button and `/` share this menu; show undo only while a restore tip remains.
            rollbackChromeDisposers.push(installRollbackUndoCommand({
              ctx: mountedCtx,
              tips: undoTips,
              rollbackFor,
              enabled: rollbackEnabled,
              t: tEnhancer,
            }))
          }
        } else {
          disableRollbackChrome()
        }
      }
      const unsubscribe = form.subscribe(synchronize)
      synchronize()
      return () => {
        unsubscribe()
        disableAll()
      }
    })
  }

  ctx.effect(async () => {
    const unmount = await ctx.remote.$mount(clientRemoteInfo)
    const agentFiber = await ctx.plugin({
      name: 'agent-enhancer-mounted',
      inject: ['remote.agentEnhancer'],
      apply: (mountedCtx: Context) => {
        adoptAgentRemote(mountedCtx)
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
