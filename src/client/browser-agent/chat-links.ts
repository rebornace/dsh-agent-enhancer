import { lastQuoteSessionId } from '../quote/session.ts'
import { agentEnhancerBrowserAgentOpenUrl } from '../remote.ts'

/** Fallback when composer has not published a quote session yet. */
const ALT_CLICK_SESSION = 'browser-agent-alt-click'

function httpUrlFromAnchor(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  const anchor = target.closest('a[href]')
  if (!(anchor instanceof HTMLAnchorElement)) return null
  const href = anchor.href?.trim() ?? ''
  if (!/^https?:\/\//iu.test(href)) return null
  return href
}

/**
 * Alt+click http(s) links in chat / preview → open in browser-agent bound tab.
 * Host approval + auto-launch; no separate “Launch browser agent” overlay.
 */
export function installBrowserChatLinks(options: {
  readonly enabled: () => boolean
  readonly getRemote: () => unknown
}): () => void {
  const onClick = (event: MouseEvent) => {
    if (!options.enabled()) return
    if (!event.altKey || event.button !== 0) return
    const url = httpUrlFromAnchor(event.target)
    if (url === null) return
    const sessionId = lastQuoteSessionId() ?? ALT_CLICK_SESSION
    event.preventDefault()
    event.stopPropagation()
    void agentEnhancerBrowserAgentOpenUrl.invoke(options.getRemote(), {
      sessionId,
      url,
    })
  }
  document.addEventListener('click', onClick, true)
  return () => {
    document.removeEventListener('click', onClick, true)
  }
}
