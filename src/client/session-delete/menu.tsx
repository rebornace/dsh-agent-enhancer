import { createElement } from 'react'
import {
  IconTrashOutlineRegular,
  MenuItemButton,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { requestSessionDelete } from './store.ts'

type SessionMenuProps = PropsRuntime<'sidebar.workspaces.session.menu.item'> & {
  readonly t: TranslateNS<'agent-enhancer'>
  readonly ctx?: { get?: (key: string) => unknown }
}

function isBusyStatus(status: unknown): boolean {
  if (status === null || typeof status !== 'object') return false
  const face = status as { running?: unknown, pendingInteraction?: unknown }
  if (face.running === true) return true
  return face.pendingInteraction !== undefined && face.pendingInteraction !== null
}

export function SessionDeleteMenuItem(props: SessionMenuProps) {
  const [, setMenuOpen] = props.useMenuOpenState()
  const status = typeof props.useSessionStatus === 'function'
    ? props.useSessionStatus(snapshot => {
      if (snapshot instanceof Map) return snapshot.get(props.sessionId)
      if (snapshot !== null && typeof snapshot === 'object') {
        return Reflect.get(snapshot, props.sessionId)
      }
      return undefined
    })
    : undefined
  const busy = isBusyStatus(status)
  const workspaceId = typeof props.useWorkspaces === 'function'
    ? props.useWorkspaces(state => {
      const items = Array.isArray((state as { items?: unknown })?.items)
        ? (state as { items: readonly { workspaceId?: string, sessionIds?: readonly string[] }[] }).items
        : []
      return items.find(workspace => (workspace.sessionIds ?? []).includes(props.sessionId))?.workspaceId
    }) as string | undefined
    : undefined

  const isMainViewOpen = (): boolean => {
    try {
      const sessions = props.ctx?.get?.('sessions') as {
        retainInfo?: (id: string) => { getSnapshot?: () => { retainedBy?: { mainView?: number } } }
      } | undefined
      const info = sessions?.retainInfo?.(props.sessionId)?.getSnapshot?.()
      return (info?.retainedBy?.mainView ?? 0) > 0
    } catch {
      return false
    }
  }

  return createElement(MenuItemButton, {
    separatorBefore: true,
    danger: true,
    disabled: busy,
    disabledReason: busy ? props.t('sessionDeleteBusy') : undefined,
    icon: createElement(IconTrashOutlineRegular),
    onSelect: () => {
      setMenuOpen(false)
      requestSessionDelete({
        sessionId: props.sessionId,
        displayTitle: props.displayTitle,
        workspaceId,
        wasOpen: isMainViewOpen(),
      })
    },
    children: props.t('sessionDelete'),
  })
}
