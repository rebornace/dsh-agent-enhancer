import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WebChatBridgeGuideIcon } from './guide-icon.tsx'
import { WEB_CHAT_PANEL_ID } from './kind.ts'
import { WebChatBridgeMainPanel } from './panel.tsx'
import './slot-types.ts'

export { WEB_CHAT_PANEL_ID }

export interface InstallWebChatBridgeLeftNavOptions {
  readonly enabled: () => boolean
  readonly t: TranslateNS<'agent-enhancer'>
  readonly remote: () => { readonly agentEnhancer: object } | undefined
}

function createSectionGate(register: () => () => void) {
  let ready = false
  let wanted = false
  let removed = false
  let dispose: (() => void) | null = null
  const apply = () => {
    if (!ready) return
    const shouldShow = wanted && !removed
    if (shouldShow && dispose === null) {
      dispose = register()
      return
    }
    if (!shouldShow && dispose !== null) {
      const stop = dispose
      dispose = null
      stop()
    }
  }
  return {
    markSupported: () => {
      ready = true
      apply()
    },
    setWanted: (visible: boolean) => {
      wanted = visible
      apply()
    },
    retire: () => {
      removed = true
      apply()
    },
  }
}

let panellistSeatProbed = false
const panellistSeatListeners = new Set<() => void>()

function setPanellistSeatProbed(probed: boolean) {
  if (panellistSeatProbed === probed) return
  panellistSeatProbed = probed
  for (const listener of panellistSeatListeners) listener()
}

export function webChatBridgeLeftNavPanellistSupported(): boolean {
  return panellistSeatProbed
}

export function subscribeWebChatBridgeLeftNavPanellist(listener: () => void): () => void {
  panellistSeatListeners.add(listener)
  return () => {
    panellistSeatListeners.delete(listener)
  }
}

export interface WebChatBridgeLeftNavHandle {
  readonly dispose: () => void
  readonly synchronize: () => void
  readonly panellistSupported: () => boolean
}

/** @internal Exported for unit tests of the market-style gate. */
export function createWebChatSectionGate(register: () => () => void) {
  return createSectionGate(register)
}

function WebChatPanellistIcon(
  props: PropsRuntime<'sidebar.panellist', typeof WEB_CHAT_PANEL_ID>,
) {
  return createElement(WebChatBridgeGuideIcon, { size: props.size ?? 16 })
}

export function installWebChatBridgeLeftNav(
  ctx: Context,
  options: InstallWebChatBridgeLeftNavOptions,
): WebChatBridgeLeftNavHandle {
  const disposers: Array<() => void> = []
  let layout: import('@deepseek-ai/dsh-client-ui-layout/client').ILayout | undefined
  let uiWorkspace: import('@deepseek-ai/dsh-client-ui-workspace/client').UiWorkspace | undefined

  const gate = createSectionGate(() => {
    const offPanel = ctx.slots.register({
      name: 'main',
      key: WEB_CHAT_PANEL_ID,
      locale: 'agent-enhancer',
      inject: () => ({ t: options.t }),
    }, props => createElement(WebChatBridgeMainPanel, {
      ...props,
      remote: options.remote,
      t: options.t,
      onLeavePanel: () => { layout?.selectPanel(null) },
      onOpenSession: (sessionId: SessionId) => { uiWorkspace?.openSession(sessionId) },
    }))
    const offRow = ctx.slots.register({
      name: 'sidebar.panellist',
      id: WEB_CHAT_PANEL_ID,
      order: 4,
      label: () => options.t('webChat'),
      locale: 'agent-enhancer',
    }, WebChatPanellistIcon)
    return () => {
      if (layout?.panelInfo.getSnapshot().activePanelId === WEB_CHAT_PANEL_ID) {
        layout.selectPanel(null)
      }
      if (typeof offRow === 'function') offRow()
      if (typeof offPanel === 'function') offPanel()
    }
  })

  disposers.push(ctx.slots.inject('sidebar.panellist', () => {
    setPanellistSeatProbed(true)
    gate.markSupported()
    return () => {}
  }))

  const layoutFiber = ctx.inject(['layout'], scoped => {
    layout = scoped.layout
  })
  disposers.push(() => { void layoutFiber.dispose() })

  const workspaceFiber = ctx.inject(['uiWorkspace'], scoped => {
    uiWorkspace = scoped.uiWorkspace
  })
  disposers.push(() => { void workspaceFiber.dispose() })

  const synchronize = () => {
    gate.setWanted(options.enabled())
  }
  synchronize()

  const dispose = () => {
    gate.retire()
    while (disposers.length > 0) disposers.pop()?.()
    setPanellistSeatProbed(false)
  }

  return {
    dispose,
    synchronize,
    panellistSupported: webChatBridgeLeftNavPanellistSupported,
  }
}
