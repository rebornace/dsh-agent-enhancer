import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote, PluginInventorySnapshot, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { resolveSettings } from '../config.ts'
import type { EnhancerSettings } from '../config.ts'
import type { AuxiliaryRequest, AuxiliaryResult } from '../host/types.ts'
import { ComposerSession } from './composer/session.ts'
import type { ModuleSwitches } from './composer/types.ts'
import { ComposerControls } from './dsh/controls.tsx'
import { ComposerOverlay } from './dsh/overlay.tsx'
import { OverlapHintStore } from './dsh/plugin-hints.ts'
import { AcceptedSettingsForm } from './dsh/settings-form.ts'
import { PluginSettings } from './dsh/settings.tsx'
import { composerLocales } from './locales.ts'
import { clientRemoteInfo, composerEnhancerCall } from './remote.ts'
import { installCss } from './styles.module.css'

type InventoryRemote = ClientRemote & {
  readonly pluginInventory: {
    list(): Promise<RemoteResult<PluginInventorySnapshot>>
  }
}

export const inject = ['remote', 'remote.pluginInventory', 'configForms', 'locale', 'slots']

export function apply(ctx: Context): void {
  ctx.effect(installCss)
  ctx.effect(() => ctx.locale.register('composer-enhancer', composerLocales))
  const t = ctx.locale.bind('composer-enhancer')
  const form = new AcceptedSettingsForm(ctx.configForms.get<EnhancerSettings>('composer-enhancer'))
  ctx.effect(() => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab', id: 'composer-enhancer', order: 120,
    label: () => t('settingsTitle'), locale: 'composer-enhancer',
    inject: () => ({ form }),
  }, PluginSettings)))
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

  const applyMounted = (mountedCtx: Context) => {
    const switches: ModuleSwitches = {
      history: () => resolveSettings(form.getSnapshot().value).historyEnabled,
      optimize: () => resolveSettings(form.getSnapshot().value).optimizeEnabled,
      predict: () => resolveSettings(form.getSnapshot().value).predictEnabled,
    }
    const generate = async (request: AuxiliaryRequest, signal: AbortSignal): Promise<AuxiliaryResult | null> => {
      const data = request.operation === 'optimize'
        ? { ...request, references: [...request.references], context: [...request.context] }
        : { ...request, context: [...request.context] }
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

  ctx.effect(async () => {
    const unmount = await ctx.remote.$mount(clientRemoteInfo)
    const fiber = await ctx.plugin({
      name: 'composer-enhancer-mounted',
      inject: ['remote.composerEnhancer'],
      apply: applyMounted,
    })
    return async () => {
      await fiber.dispose()
      await unmount()
    }
  })
}
