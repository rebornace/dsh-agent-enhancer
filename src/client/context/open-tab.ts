import type { ContextInspectCategory } from '../../host/context-inspect.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CONTEXT_INSPECT_TAB_KIND } from './tab.ts'
import type { ContextInspectTabParams } from './tab.ts'

export interface SidebarRightOpenTab {
  openTab(kind: string, options?: { readonly params?: ContextInspectTabParams }): void
}

/** Open the context-inspect page; poll briefly until the rightbar session surface is mounted. */
export function openContextInspectTab(
  sidebarRight: SidebarRightOpenTab | undefined,
  params: { readonly sessionId: SessionId, readonly category: ContextInspectCategory, readonly itemId?: string },
): () => void {
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

  const run = () => {
    if (cancelled) return
    attempts += 1
    if (sidebarRight === undefined || typeof sidebarRight.openTab !== 'function') {
      if (attempts >= maxAttempts) return finish()
      timer = setTimeout(run, 150)
      return
    }
    try {
      sidebarRight.openTab(CONTEXT_INSPECT_TAB_KIND, { params })
      finish()
    } catch {
      if (attempts >= maxAttempts) return finish()
      timer = setTimeout(run, 200)
    }
  }

  run()
  return finish
}
