import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { McpConnectorsGuideIcon } from './guide-icon.tsx'
import { MCP_CONNECTORS_PANEL_ID } from './kind.ts'
import { McpConnectorsMainPanel } from './tab.tsx'
import './slot-types.ts'

export { MCP_CONNECTORS_PANEL_ID }

export interface InstallMcpConnectorsLeftNavOptions {
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

export function mcpConnectorsLeftNavPanellistSupported(): boolean {
  return panellistSeatProbed
}

export function subscribeMcpConnectorsLeftNavPanellist(listener: () => void): () => void {
  panellistSeatListeners.add(listener)
  return () => {
    panellistSeatListeners.delete(listener)
  }
}

export interface McpConnectorsLeftNavHandle {
  readonly dispose: () => void
  readonly synchronize: () => void
  readonly panellistSupported: () => boolean
}

function McpPanellistIcon(
  props: PropsRuntime<'sidebar.panellist', typeof MCP_CONNECTORS_PANEL_ID>,
) {
  return createElement(McpConnectorsGuideIcon, { size: props.size ?? 16 })
}

export function installMcpConnectorsLeftNav(
  ctx: Context,
  options: InstallMcpConnectorsLeftNavOptions,
): McpConnectorsLeftNavHandle {
  const disposers: Array<() => void> = []
  let layout: import('@deepseek-ai/dsh-client-ui-layout/client').ILayout | undefined

  const gate = createSectionGate(() => {
    const offPanel = ctx.slots.register({
      name: 'main',
      key: MCP_CONNECTORS_PANEL_ID,
      locale: 'agent-enhancer',
      inject: () => ({ t: options.t }),
    }, props => createElement(McpConnectorsMainPanel, {
      ...props,
      remote: options.remote,
      t: options.t,
    }))
    const offRow = ctx.slots.register({
      name: 'sidebar.panellist',
      id: MCP_CONNECTORS_PANEL_ID,
      order: 3,
      label: () => options.t('mcpConnectors'),
      locale: 'agent-enhancer',
    }, McpPanellistIcon)
    return () => {
      if (layout?.panelInfo.getSnapshot().activePanelId === MCP_CONNECTORS_PANEL_ID) {
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
    panellistSupported: mcpConnectorsLeftNavPanellistSupported,
  }
}
