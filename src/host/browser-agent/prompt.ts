import type { Context } from '@deepseek-ai/cordis'

type SystemPromptService = {
  readonly section: (section: {
    readonly name: string
    readonly order: number
    readonly text: string | ((context: unknown) => string)
    readonly interpolate?: boolean
  }) => () => void
  readonly getSectionOrder?: (name: string) => number
}

const SECTION_NAME = 'agent-enhancer:browser-agent'

/** Site-agnostic guidance (Playwright MCP / browser-use style). No per-site scrapers. */
const GUIDANCE = [
  '## Browser agent (Desktop dedicated browser: Safari/Chrome on Mac, Chrome/Edge on Windows)',
  'When the user asks to open a website, browse the web, click pages, fill forms, read on-page content, log into a site, or verify UI in a real browser, you MUST use the browser_* tools — do not only describe steps or ask the user to open a browser manually.',
  'Do NOT open the system default browser via shell (Start-Process, open, xdg-open, cmd start). That bypasses the dedicated browser agent. Use browser_navigate (and then snapshot/click) instead. web_fetch / web_search are fine for raw HTTP/API reads, not as a substitute for interactive browsing.',
  'Goal phases: (1) reach the target page once, (2) stay and observe/extract, (3) answer the user. Do not keep navigating without a new user goal.',
  'Preferred loop: browser_navigate (or reuse a tab) → browser_wait if slow → browser_snapshot → click/type/scroll using listed refs → browser_snapshot or browser_extract again.',
  'browser_navigate replaces the current tab by default. When the user asks to open another site without closing the current one, compare two pages, or keep a previous page (search results, docs, etc.), call browser_navigate with newTab=true. Then browser_list_tabs / browser_follow_tab (or the Desktop sidebar tab list) to switch.',
  'Perception is accessibility-tree based (Playwright MCP style): prefer refs that show href=…. browser_screenshot exists but is optional — do not wait for screenshots; dead clicks are usually missing hrefs on SPA cards, not missing vision.',
  'If browser_click leaves pathname unchanged and that ref has an http(s) href, the host may open that same href once. If the tool says the ref has no href / lists page_links: do NOT re-click the same ref — browser_navigate once to a page_links URL or pick another ref that lists href=. Never invent URLs.',
  'Below-the-fold or long content: browser_scroll → browser_wait → browser_extract. Report what extract returns; do not hop to unrelated pages.',
  'The dedicated browser auto-launches when needed; never tell the user to click “Launch browser agent” unless the tool error says so.',
  'Mutation tools may pause for an in-app Allow card — wait for allow/deny.',
  'Login / captcha / 2FA: NEVER type passwords. When needs_human appears, call browser_ask_user and STOP until the user finishes in the dedicated window. A bare “Log in” chip on a normal page is not a wall.',
  'Do not invent page content or refs. Prefer finishing the user task over exploring more pages.',
].join('\n')

/**
 * Soft-register system-prompt guidance while Browser agent is enabled.
 * Uses ctx.get('systemPrompt') so missing inject does not hard-fail the plugin.
 */
export function registerBrowserAgentPrompt(ctx: Context): () => void {
  let disposeSection: (() => void) | undefined
  try {
    const service = ctx.get('systemPrompt') as SystemPromptService | undefined
    if (service === undefined || typeof service.section !== 'function') {
      return () => undefined
    }
    const order = typeof service.getSectionOrder === 'function'
      ? service.getSectionOrder('TOOL_COMPUTER_USE') + 10
      : 3010
    disposeSection = service.section({
      name: SECTION_NAME,
      order,
      text: GUIDANCE,
      interpolate: false,
    })
  } catch {
    return () => undefined
  }
  return () => {
    try {
      disposeSection?.()
    } catch {
      // ignore
    }
  }
}
