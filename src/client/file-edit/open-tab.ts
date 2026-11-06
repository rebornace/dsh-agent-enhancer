import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { fileAddressOf } from './address.ts'
import { FILE_EDIT_TAB_KIND } from './kind.ts'

/** Official document-preview tab kind — used to return from the editor. */
export const DOCUMENT_PREVIEW_KIND = 'text'

export interface FileEditNavigator {
  openResource?(
    address: string,
    options?: {
      readonly kind?: string
      readonly replaceTab?: string
      readonly revealIfOpened?: boolean
    },
  ): void
  active?(): { readonly id: string, readonly contentId: string } | undefined
  readonly openTabs?: {
    getSnapshot(): readonly {
      readonly sessionId: string
      readonly tabId: string
      readonly contentId: string
      readonly kind: string
    }[]
  }
}

function replaceTabId(
  sidebarRight: FileEditNavigator | undefined,
  sessionId: SessionId,
  address: string,
): string | undefined {
  // Prefer the active tab: Edit lives on the preview header, so the file tab is
  // focused. Do not require contentId equality — preview may use a relative
  // address while we open with an absolute Host path (or the reverse).
  try {
    const active = sidebarRight?.active?.()
    if (
      active !== undefined
      && typeof active.contentId === 'string'
      && active.contentId.startsWith('dsh-resource://file/')
    ) {
      return active.id
    }
  } catch { /* ignore */ }
  try {
    const open = sidebarRight?.openTabs?.getSnapshot?.() ?? []
    const exact = open.find(entry => entry.sessionId === sessionId && entry.contentId === address)
    if (exact !== undefined) return exact.tabId
    const sameSessionFile = open.find(entry => (
      entry.sessionId === sessionId
      && entry.contentId.startsWith('dsh-resource://file/')
    ))
    return sameSessionFile?.tabId
  } catch {
    return undefined
  }
}

/** Open the Monaco editor in place of the current file preview tab. */
export function openFileEditor(
  sidebarRight: FileEditNavigator | undefined,
  sessionId: SessionId,
  path: string,
): void {
  if (sidebarRight === undefined || typeof sidebarRight.openResource !== 'function') return
  const address = fileAddressOf(sessionId, path)
  const replaceTab = replaceTabId(sidebarRight, sessionId, address)
  sidebarRight.openResource(address, {
    kind: FILE_EDIT_TAB_KIND,
    ...(replaceTab === undefined ? {} : { replaceTab }),
  })
}

/** Return to the official document preview for the same file address. */
export function openFilePreview(
  sidebarRight: FileEditNavigator | undefined,
  sessionId: SessionId,
  path: string,
): void {
  if (sidebarRight === undefined || typeof sidebarRight.openResource !== 'function') return
  const address = fileAddressOf(sessionId, path)
  const replaceTab = replaceTabId(sidebarRight, sessionId, address)
  sidebarRight.openResource(address, {
    kind: DOCUMENT_PREVIEW_KIND,
    ...(replaceTab === undefined ? {} : { replaceTab }),
  })
}
