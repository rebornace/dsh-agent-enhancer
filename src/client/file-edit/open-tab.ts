import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  fileAddressFor,
  fileAddressOf,
  skillDocumentPath,
} from './address.ts'
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
  openTab?(kind: string, options?: { readonly params?: object }): void
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

/**
 * Open a file the way official 工作区文件 does: no forced `kind`, so the
 * document-preview registry (text / image / pdf / …) claims the address.
 */
export function openWorkspaceFile(
  sidebarRight: FileEditNavigator | undefined,
  sessionId: SessionId,
  path: string,
): void {
  if (sidebarRight === undefined || typeof sidebarRight.openResource !== 'function') return
  sidebarRight.openResource(fileAddressOf(sessionId, path), { revealIfOpened: true })
}

/**
 * Open a skill SKILL.md for document preview.
 * Uses the same session-scoped address grammar as FilesBody / Extra folders
 * (`fileAddressFor`) — absolute-scope URIs are not how Desktop opens files.
 *
 * When called from a main panel, the session right-bar may not be mounted yet;
 * we poll briefly (same pattern as `openContextInspectTab`).
 */
export function scheduleOpenSkillDocument(options: {
  readonly getSidebarRight: () => FileEditNavigator | undefined
  readonly sessionId: SessionId
  readonly path: string
  readonly cwd?: string
  readonly beforeOpen?: () => void
}): () => void {
  const documentPath = skillDocumentPath(options.path)
  const address = fileAddressFor(options.sessionId, options.cwd, documentPath)

  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempts = 0
  const maxAttempts = 40

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const finish = () => {
    cancelled = true
    clear()
  }

  options.beforeOpen?.()

  const run = () => {
    if (cancelled) return
    attempts += 1
    const sidebarRight = options.getSidebarRight()
    if (sidebarRight === undefined || typeof sidebarRight.openResource !== 'function') {
      if (attempts >= maxAttempts) return finish()
      timer = setTimeout(run, 150)
      return
    }
    try {
      sidebarRight.openResource(address, { revealIfOpened: true })
      finish()
    } catch {
      if (attempts >= maxAttempts) return finish()
      timer = setTimeout(run, 200)
    }
  }

  // First tick after leaving the main panel so conversation + right bar can mount.
  timer = setTimeout(run, 0)
  return finish
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
