import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserApprovalGate } from './approval.ts'
import type { BrowserDriver } from './driver.ts'
import type { BrowserHumanGate } from './human-gate.ts'
import { pickAutoNavigateHref, pathsDiffer } from './auto-nav.ts'
import type { SnapshotBody } from './protocol.ts'
import type { BrowserSessionState } from './session-state.ts'

type ToolExec = {
  readonly signal: AbortSignal
  readonly agent?: { readonly session?: { readonly id?: string } }
}

const HUMAN_WAIT_TIMEOUT_MS = 15 * 60_000

function textTool(name: string, description: string, parameters: ParameterSchemaSpec, execute: (
  args: Record<string, unknown>,
  exec: ToolExec,
) => Promise<string>, timeoutMs = 60_000) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return await execute(args as Record<string, unknown>, exec as ToolExec)
    },
  })
}

function formatSnapshot(body: SnapshotBody, extra?: readonly string[]): string {
  const lines = [
    `url: ${body.url}`,
    `title: ${body.title}`,
    body.tabId !== undefined ? `tabId: ${body.tabId}` : null,
    body.rebound === true ? 'note: rebound to focused tab (previous bound tab was gone)' : null,
    body.conflict === true ? 'note: tab focus conflict pending — user must Follow or Stay in Desktop' : null,
    body.needsHuman === true
      ? [
        'needs_human: true',
        'Action: Login/captcha/auth wall. Call browser_ask_user NOW and STOP. Wait for the user to finish in the dedicated browser, then browser_snapshot / browser_extract.',
        'Do NOT type passwords or solve captchas.',
      ].join('\n')
      : null,
    typeof body.source === 'string' ? `snapshot_source: ${body.source}` : null,
    typeof body.extensionVersion === 'string' ? `extension: ${body.extensionVersion}` : null,
    typeof body.anchorCount === 'number' ? `anchors_in_dom: ${body.anchorCount}` : null,
    typeof body.note === 'string' && body.note.trim() !== '' ? `note: ${body.note.trim()}` : null,
    ...(extra ?? []),
    'interactive (prefer refs that include href=… ; never invent URLs; re-snapshot after navigation):',
    ...body.nodes.slice(0, 80).map(node => (
      `- [${node.ref}] ${node.role}${node.tag !== undefined ? `/${node.tag}` : ''}${node.sensitive === true ? ' [sensitive]' : ''}${typeof node.href === 'string' && node.href !== '' ? ` href=${JSON.stringify(node.href)}` : ''} ${JSON.stringify(node.name)}`
    )),
    'text_preview (short — use browser_extract for long/below-fold content):',
    body.textPreview.slice(0, 2_000),
  ]
  return lines.filter(line => line !== null).join('\n')
}

function sessionIdOf(exec: ToolExec): string {
  const id = exec.agent?.session?.id
  if (typeof id === 'string' && id.trim() !== '') return id.trim()
  return 'unknown-session'
}

function formatBridgeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/click_noop:|click_blocked:/i.test(message)) {
    return `${message}\nDo not retry the same browser_click. Prefer browser_navigate or a ref with href=.`
  }
  if (/No element for ref/i.test(message) || /Refs are only valid/i.test(message)) {
    return `${message}\nAction: call browser_snapshot, then retry with a fresh ref. Never invent refs.`
  }
  if (/about:blank|not an http\(s\) page|Cannot inject into|Cannot access contents of url/i.test(message)) {
    return `${message}\nAction: The dedicated browser was still on about:blank. Call browser_navigate to the https URL again, wait, then browser_snapshot. Do not click yet.`
  }
  if (/all_urls|activeTab|unserializable|Page injection failed|Debugger attach failed|Cannot automate restricted URL/i.test(message)) {
    return `${message}\nAction: STOP clicking. Tell the user to fully quit the dedicated browser window and click “Launch browser agent” again (extension v0.2.5+). Do not invent refs or keep calling browser_click.`
  }
  if (/not typeable/i.test(message)) {
    return `${message}\nAction: call browser_snapshot and choose a textbox / input ref.`
  }
  if (/extension not connected|WebSocket|not listening|did not connect|Could not launch/i.test(message)) {
    return `${message}\nAction: Browser agent tried to auto-launch the dedicated browser. If it still fails, ask the user to open the right-sidebar “Browser agent” tab and launch once, then retry the same browser_* tool. Do not ask them to open their everyday Chrome manually.`
  }
  if (/Tab focus conflict/i.test(message)) {
    return `${message}\nAction: ask the user to choose Follow or Stay in the Desktop browser-agent card.`
  }
  if ((error as { needsHuman?: boolean })?.needsHuman === true || /needs_human|captcha|验证码|人机验证/i.test(message)) {
    return `${message}\nneeds_human: true\nAction: Call browser_ask_user now (blocking). Do not retry clicks. After it returns, call browser_snapshot.`
  }
  return message
}

async function runBridge<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw new Error(formatBridgeError(error))
  }
}

function maskTypeSummary(text: string): string {
  if (text.length <= 2) return '••'
  return `${text.slice(0, 1)}…(${text.length} chars)`
}

export interface BrowserToolsOptions {
  /**
   * Live driver, or a getter. Agent tools must use a getter so browser
   * hard-resets (new PlaywrightDriver instance) are visible mid-conversation.
   */
  readonly driver: BrowserDriver | (() => BrowserDriver)
  /**
   * Optional host hook: hard-align running browser to the current preference
   * before ensureReady. Required so dialog `browser_navigate` honors Settings /
   * sidebar browser switches without requiring the Launch button.
   */
  readonly alignPreference?: (startUrl?: string) => Promise<void>
  readonly approval: BrowserApprovalGate
  readonly human: BrowserHumanGate
  readonly sessions: BrowserSessionState
  readonly enabled: () => boolean
  readonly onMutation?: (info: {
    readonly sessionId: string
    readonly tool: string
    readonly url?: string
  }) => void
}

function driverOf(options: BrowserToolsOptions): BrowserDriver {
  const value = options.driver
  return typeof value === 'function' ? value() : value
}

export function registerBrowserTools(ctx: Context, options: BrowserToolsOptions): () => void {
  const disposers: Array<() => void> = []

  const guardEnabled = () => {
    if (!options.enabled()) {
      throw new Error('Browser agent is disabled in settings (智能体增强 → 浏览器 Agent).')
    }
  }

  const rememberTab = async (sessionId: string, tabId: number | undefined) => {
    if (typeof tabId !== 'number') return
    options.sessions.bind(sessionId, tabId)
    try {
      await driverOf(options).bind(tabId, sessionId)
    } catch {
      // Driver may already be bound.
    }
  }

  const ensureSessionTab = async (sessionId: string) => {
    const tabId = options.sessions.tabOf(sessionId)
    if (tabId === undefined) return
    try {
      await driverOf(options).bind(tabId, sessionId)
    } catch {
      // ignore — first op may rebind if tab gone
    }
  }

  const ensureConnected = async (startUrl?: string) => {
    // Align first so Agent dialog opens use the latest browser preference.
    if (options.alignPreference !== undefined) {
      await options.alignPreference(startUrl)
      return
    }
    await driverOf(options).ensureReady(startUrl)
  }

  const requireMutation = async (
    exec: ToolExec,
    tool: string,
    summary: string,
    url: string | undefined,
  ) => {
    const sessionId = sessionIdOf(exec)
    // Prefer a real http(s) URL so allow-origin can stick for the session.
    // pageStatus may be about:blank / empty right after launch — fall back to last known.
    let effectiveUrl = typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined
    if (effectiveUrl === undefined) {
      effectiveUrl = options.sessions.lastHttpUrl(sessionId)
    } else {
      options.sessions.rememberHttpUrl(sessionId, effectiveUrl)
    }
    const decision = await options.approval.requestApproval({
      sessionId,
      tool,
      summary,
      url: effectiveUrl,
      signal: exec.signal,
    })
    if (decision === 'deny') {
      options.sessions.record({
        sessionId,
        tool,
        summary,
        url: effectiveUrl ?? url,
        outcome: 'denied',
      })
      throw new Error('User denied this browser action.')
    }
  }

  const noteHuman = (sessionId: string, body: { needsHuman?: boolean }, error?: unknown) => {
    if (body.needsHuman === true || (error as { needsHuman?: boolean })?.needsHuman === true) {
      options.sessions.setNeedsHuman(sessionId, 'Login or captcha required in the bound browser tab')
      return
    }
    if (/needs_human|login|captcha|验证码|登录/i.test(error instanceof Error ? error.message : String(error ?? ''))) {
      options.sessions.setNeedsHuman(sessionId, 'Login or captcha required in the bound browser tab')
      return
    }
    options.sessions.clearNeedsHuman(sessionId)
  }

  const focusBoundTab = async (sessionId: string, tabId?: number) => {
    const id = tabId ?? options.sessions.tabOf(sessionId)
    if (typeof id !== 'number') return
    try {
      await driverOf(options).followTab(id, true)
    } catch {
      // Focus is best-effort; human can still use the dedicated window.
    }
  }

  /**
   * Mature-agent pattern (Claude in Chrome / Browser MCP): pause the open tool
   * call until the user finishes login/captcha, then return control to the model.
   */
  const pauseForHuman = async (input: {
    readonly sessionId: string
    readonly prompt: string
    readonly detail: string
    readonly url?: string
    readonly tabId?: number
    readonly signal: AbortSignal
  }): Promise<'continued' | 'cancelled'> => {
    options.sessions.setNeedsHuman(input.sessionId, input.detail)
    await focusBoundTab(input.sessionId, input.tabId)
    try {
      return await options.human.waitForHuman({
        sessionId: input.sessionId,
        prompt: input.prompt,
        detail: input.detail,
        ...(input.url === undefined ? {} : { url: input.url }),
        signal: input.signal,
      })
    } finally {
      // Keep banner until ack resolves; clear if cancelled/aborted without ack.
      if (options.human.current()?.sessionId !== input.sessionId) {
        options.sessions.clearNeedsHuman(input.sessionId)
      }
    }
  }

  const rememberSnapshotRefs = (sessionId: string, body: SnapshotBody) => {
    options.sessions.setLastRefs(sessionId, body.nodes.map(node => node.ref))
    const hrefs = new Map<number, string>()
    const names = new Map<number, string>()
    for (const node of body.nodes) {
      if (typeof node.href === 'string' && /^https?:\/\//iu.test(node.href)) {
        hrefs.set(node.ref, node.href)
      }
      if (typeof node.name === 'string' && node.name.trim() !== '') {
        names.set(node.ref, node.name.trim())
      }
    }
    options.sessions.setLastHrefs(sessionId, hrefs)
    options.sessions.setLastNames(sessionId, names)
  }

  const requireFreshRef = (sessionId: string, ref: number, tool: string) => {
    if (options.sessions.hasRef(sessionId, ref)) return
    const known = options.sessions.lastRefList(sessionId)
    if (known.length === 0) {
      throw new Error(
        `${tool}: ref ${ref} is not from a browser_snapshot in this session. `
        + 'Call browser_snapshot first and use a listed [ref]. Never invent refs.',
      )
    }
    throw new Error(
      `${tool}: ref ${ref} is not in the latest browser_snapshot `
      + `(have: ${known.slice(0, 24).join(', ')}${known.length > 24 ? ', …' : ''}). `
      + 'Call browser_snapshot again and pick a listed ref — do not guess.',
    )
  }

  const snapshotWithHumanPause = async (sessionId: string, exec: ToolExec): Promise<string> => {
    let body = await runBridge(() => driverOf(options).snapshot())
    await rememberTab(sessionId, body.tabId)
    options.sessions.rememberHttpUrl(sessionId, body.url)
    // Do NOT inject SSR-fetched chrome links as synthetic refs. Many SPAs ship nav-only HTML
    // and hydrate content cards later; fake hrefs mislead the model into hopping section hubs.
    // Live href binding belongs in the driver (interactive ∪ document anchors ∪ proximity).
    rememberSnapshotRefs(sessionId, body)
    if (body.nodes.length === 0) {
      options.sessions.clearLastRefs(sessionId)
      options.sessions.record({
        sessionId,
        tool: 'browser_snapshot',
        summary: `Empty snapshot ${body.url}`,
        url: body.url,
        outcome: 'error',
      })
      return [
        formatSnapshot(body, [
          'warning: zero interactive refs — page may still be loading, be a blank/restricted document, or injection failed.',
          'Action: browser_wait then browser_snapshot again. Do NOT call browser_click with invented refs.',
        ]),
      ].join('\n')
    }
    if (body.needsHuman !== true) {
      options.sessions.clearNeedsHuman(sessionId)
      options.sessions.record({
        sessionId,
        tool: 'browser_snapshot',
        summary: `Snapshot ${body.url} (${body.nodes.length} refs)`,
        url: body.url,
        outcome: 'ok',
      })
      return formatSnapshot(body)
    }

    // Strong login/captcha wall only (extension heuristic). Auto-pause like Claude in Chrome.
    options.sessions.record({
      sessionId,
      tool: 'browser_snapshot',
      summary: `Needs human: ${body.url}`,
      url: body.url,
      outcome: 'needs_human',
    })
    const prompt = [
      'Login, captcha, or verification is required in the dedicated browser window.',
      `Page: ${body.title || '(no title)'}`,
      `URL: ${body.url}`,
      'Complete it there, then click “I’m done — continue”. Do not use your everyday browser.',
    ].join(' ')
    const status = await pauseForHuman({
      sessionId,
      prompt,
      detail: `Login/captcha: ${body.title || body.url}`,
      url: body.url,
      tabId: body.tabId,
      signal: exec.signal,
    })
    if (status === 'cancelled') {
      throw new Error(
        'Human login wait was cancelled. Call browser_ask_user again when the user is ready, or ask what they want next.',
      )
    }
    options.sessions.clearNeedsHuman(sessionId)
    const after = await runBridge(() => driverOf(options).snapshot())
    await rememberTab(sessionId, after.tabId)
    rememberSnapshotRefs(sessionId, after)
    noteHuman(sessionId, after)
    options.sessions.record({
      sessionId,
      tool: 'browser_snapshot',
      summary: `After human: ${after.url}`,
      url: after.url,
      outcome: after.needsHuman === true ? 'needs_human' : 'ok',
    })
    return formatSnapshot(after, [
      'user_ack: continued',
      after.needsHuman === true
        ? 'note: page still looks like login/captcha — call browser_ask_user again if the user is not done, otherwise continue with a different approach and tell the user what you see.'
        : 'note: user finished the human step — continue the original task with these fresh refs.',
    ])
  }

  disposers.push(ctx.tools.register(textTool(
    'browser_status',
    'Check the Desktop dedicated-browser bridge (Mac: Safari/Chrome; Windows: Chrome/Edge): connection, bound tab URL/title/tabId. Use this for any real-browser / webpage / on-page task. Auto-launches the dedicated browser when disconnected — do not ask the user to launch manually first.',
    {},
    async (_args, exec) => {
      guardEnabled()
      const sessionId = sessionIdOf(exec)
      const st = driverOf(options).status()
      if (!st.listening) {
        return [
          `driver: ${st.kind}`,
          'bridge: not listening',
          st.port !== undefined ? `port: ${st.port}` : null,
          `error: ${st.lastError ?? 'not started'}`,
        ].filter(line => line !== null).join('\n')
      }
      if (!st.ready) {
        try {
          await ensureConnected()
        } catch (error) {
          return [
            `driver: ${st.kind}`,
            st.endpoint !== undefined ? `bridge: listening on ${st.endpoint}` : 'bridge: listening',
            'extension: disconnected',
            formatBridgeError(error),
          ].join('\n')
        }
      }
      try {
        await ensureSessionTab(sessionId)
        const tab = await runBridge(() => driverOf(options).pageStatus())
        await rememberTab(sessionId, tab.tabId)
        return [
          `driver: ${driverOf(options).kind}`,
          'bridge: ok',
          'extension: connected',
          `url: ${tab.url}`,
          `title: ${tab.title}`,
          `tabId: ${tab.tabId}`,
          `sessionBound: ${options.sessions.tabOf(sessionId) === tab.tabId ? 'yes' : 'no'}`,
          `bound: ${tab.bound === false ? 'no' : 'yes'}`,
          tab.rebound === true ? 'note: rebound to focused tab' : null,
          tab.conflict === true ? 'note: tab focus conflict pending' : null,
        ].filter(line => line !== null).join('\n')
      } catch (error) {
        noteHuman(sessionId, {}, error)
        return `driver: ${driverOf(options).kind}\nbridge: listening\nextension: connected but status failed: ${formatBridgeError(error)}`
      }
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'browser_snapshot',
    'Read the dedicated browser tab: URL, title, numbered interactive refs, text preview. ALWAYS call this before browser_click / browser_type and ONLY click refs listed here — never invent refs. Password fields are sensitive. Only a real login/captcha wall auto-pauses for the user (a homepage “登录” link does not). Auto-launches when disconnected. Read-only; no approval.',
    {},
    async (_args, exec) => {
      guardEnabled()
      const sessionId = sessionIdOf(exec)
      await ensureConnected()
      await ensureSessionTab(sessionId)
      try {
        return await snapshotWithHumanPause(sessionId, exec)
      } catch (error) {
        noteHuman(sessionId, {}, error)
        options.sessions.record({
          sessionId,
          tool: 'browser_snapshot',
          summary: 'Snapshot failed',
          outcome: 'error',
        })
        throw error
      }
    },
    HUMAN_WAIT_TIMEOUT_MS,
  )))

  disposers.push(ctx.tools.register(textTool(
    'browser_ask_user',
    'Pause the agent turn and wait for the user (login, captcha, 2FA, or any step only a human can do). Brings the bound tab forward, shows a Desktop Continue card, and BLOCKS until they click Continue — then returns so you can browser_snapshot and proceed. Prefer this over chatting and spinning. Never type passwords or solve captchas with browser_type/browser_click. Use when needs_human is set, the page is blocked, or you are unsure.',
    {
      prompt: {
        type: 'string',
        required: true,
        description: 'Short message for the user (their language): what to do in the dedicated browser window.',
      },
    },
    async (args, exec) => {
      guardEnabled()
      const sessionId = sessionIdOf(exec)
      const prompt = String(args.prompt ?? '').trim()
      if (prompt === '') throw new Error('prompt is required')
      await ensureConnected()
      await ensureSessionTab(sessionId)
      let url: string | undefined
      let tabId: number | undefined
      try {
        const tab = await driverOf(options).pageStatus()
        url = tab.url
        tabId = tab.tabId
        await rememberTab(sessionId, tab.tabId)
      } catch {
        // status optional
      }
      options.sessions.record({
        sessionId,
        tool: 'browser_ask_user',
        summary: prompt.slice(0, 160),
        ...(url === undefined ? {} : { url }),
        outcome: 'needs_human',
      })
      const status = await pauseForHuman({
        sessionId,
        prompt,
        detail: prompt.slice(0, 240),
        ...(url === undefined ? {} : { url }),
        ...(tabId === undefined ? {} : { tabId }),
        signal: exec.signal,
      })
      options.sessions.clearNeedsHuman(sessionId)
      if (status === 'cancelled') {
        return 'user_ack: cancelled\nAction: Ask what the user wants next, or call browser_ask_user again.'
      }
      options.sessions.record({
        sessionId,
        tool: 'browser_ask_user',
        summary: 'User continued',
        ...(url === undefined ? {} : { url }),
        outcome: 'ok',
      })
      return [
        'user_ack: continued',
        `prompt_was: ${prompt}`,
        'Action: call browser_snapshot now, then continue the task. If still on login/captcha, call browser_ask_user again.',
      ].join('\n')
    },
    HUMAN_WAIT_TIMEOUT_MS,
  )))

  disposers.push(ctx.tools.register(textTool(
    'browser_navigate',
    'Open or navigate the dedicated Desktop browser to an http(s) URL. Prefer this over telling the user to open a browser themselves. Auto-launches when disconnected. Requires approval unless the origin is already allowed. After navigation call browser_snapshot (it will pause for login/captcha if needed). Use newTab=true when the user wants to keep the previous page open, compare sites, or explicitly asks for a new tab — otherwise the current tab is replaced.',
    {
      url: {
        type: 'string',
        required: true,
        description: 'Absolute http(s) URL to open.',
      },
      newTab: {
        type: 'boolean',
        description: 'When true, open in a new tab and keep the previous tab. Default false (navigate current tab).',
      },
    },
    async (args, exec) => {
      guardEnabled()
      const sessionId = sessionIdOf(exec)
      const url = String(args.url ?? '').trim()
      const newTab = args.newTab === true
      if (url === '') throw new Error('url is required')
      await ensureConnected(url)
      await ensureSessionTab(sessionId)
      await requireMutation(
        exec,
        'browser_navigate',
        `${newTab ? 'Open new tab' : 'Navigate'} to ${url}`,
        url,
      )
      try {
        const result = await runBridge(() => driverOf(options).navigate(url, { newTab }))
        await rememberTab(sessionId, (result as { tabId?: number }).tabId)
        options.sessions.rememberHttpUrl(sessionId, result.url)
        options.sessions.record({
          sessionId,
          tool: 'browser_navigate',
          summary: `${newTab ? 'Open new tab' : 'Navigate'} to ${url}`,
          url: result.url,
          outcome: 'ok',
        })
        options.onMutation?.({ sessionId, tool: 'browser_navigate', url: result.url })
        return [
          newTab ? 'opened_new_tab' : 'navigated',
          `url: ${result.url}`,
          `title: ${result.title}`,
          result.tabId !== undefined ? `tabId: ${result.tabId}` : null,
          'Action: call browser_snapshot next. For long page content use browser_extract after scroll if needed. Use browser_list_tabs / browser_follow_tab (or the sidebar tab list) to switch among tabs.',
        ].filter(line => line !== null).join('\n')
      } catch (error) {
        noteHuman(sessionId, {}, error)
        options.sessions.record({
          sessionId,
          tool: 'browser_navigate',
          summary: `${newTab ? 'Open new tab' : 'Navigate'} to ${url}`,
          url,
          outcome: 'error',
        })
        throw error
      }
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'browser_click',
    'Click an interactive element by ref from the latest browser_snapshot. Requires approval. If the ref is missing/stale, browser_snapshot first. Dead clicks may follow that same ref’s http(s) href only — never invent other URLs. Do NOT use this to submit passwords or solve captchas — call browser_ask_user instead. Auto-launches when disconnected.',
    {
      ref: {
        type: 'number',
        required: true,
        description: 'Element ref from the latest browser_snapshot.',
      },
    },
    async (args, exec) => {
      guardEnabled()
      const sessionId = sessionIdOf(exec)
      const ref = Number(args.ref)
      if (!Number.isFinite(ref)) throw new Error('ref must be a number')
      await ensureConnected()
      await ensureSessionTab(sessionId)
      let url: string | undefined
      try {
        url = (await driverOf(options).pageStatus()).url
      } catch {
        url = undefined
      }
      requireFreshRef(sessionId, ref, 'browser_click')
      if (options.sessions.isDeadClickRef(sessionId, ref)) {
        throw new Error(
          `click_blocked: ref ${ref} already failed with no navigation. `
          + 'Do NOT browser_click it again. browser_navigate to a content URL, or browser_snapshot and use a ref that lists href=.',
        )
      }
      const snapshotHref = options.sessions.hrefOfRef(sessionId, ref)
      await requireMutation(exec, 'browser_click', `Click ref ${ref}`, url)
      try {
        const beforeUrl = typeof url === 'string' ? url : ''
        let result = await runBridge(() => driverOf(options).click(ref))
        await rememberTab(sessionId, (result as { tabId?: number }).tabId)
        const href = (
          typeof result.href === 'string' && result.href !== ''
            ? result.href
            : (snapshotHref ?? '')
        )
        // Only origin+pathname counts (ignore query churn).
        let navigated = beforeUrl !== '' && pathsDiffer(beforeUrl, result.url)
        let warning = typeof result.warning === 'string' ? result.warning : ''
        let resolvedHref = href
        // Universal recovery: follow THIS ref's href only first.
        let followTarget = (
          !navigated
          && resolvedHref !== ''
          && /^https?:\/\//i.test(resolvedHref)
          && pathsDiffer(beforeUrl || result.url, resolvedHref)
        ) ? resolvedHref : ''
        if (followTarget !== '') {
          const followed = await runBridge(() => driverOf(options).navigate(followTarget))
          await rememberTab(sessionId, (followed as { tabId?: number }).tabId)
          result = { ...followed, href: followTarget, changed: true }
          resolvedHref = followTarget
          navigated = beforeUrl === '' || pathsDiffer(beforeUrl, followed.url)
          warning = navigated
            ? 'Click left pathname unchanged; opened this ref’s own href via navigate.'
            : 'Opened this ref’s href but pathname still looks unchanged.'
        }

        const pageLinks = (result.pageLinks ?? [])
          .filter(item => typeof item.href === 'string' && item.href !== '')
          .map(item => ({ href: item.href, name: item.name || '' }))
        const preferredName = options.sessions.nameOfRef(sessionId, ref) || ''

        // Auto-open only a name-matched live link from the extension — never SSR chrome hubs.
        if (!navigated && followTarget === '') {
          const autoHref = pickAutoNavigateHref(pageLinks, beforeUrl || result.url, preferredName)
          if (autoHref !== null) {
            const followed = await runBridge(() => driverOf(options).navigate(autoHref))
            await rememberTab(sessionId, (followed as { tabId?: number }).tabId)
            result = { ...followed, href: autoHref, changed: true }
            resolvedHref = autoHref
            followTarget = autoHref
            navigated = beforeUrl === '' || pathsDiffer(beforeUrl, followed.url)
            warning = navigated
              ? 'Click was a no-op; host auto-navigated to a name-matched document link.'
              : 'Host tried name-matched auto-navigate after dead click but pathname still unchanged.'
          }
        }

        options.sessions.clearLastRefs(sessionId)
        if (!navigated) {
          options.sessions.markDeadClickRef(sessionId, ref)
          options.sessions.record({
            sessionId,
            tool: 'browser_click',
            summary: `Click ref ${ref} (noop)`,
            url: result.url,
            outcome: 'error',
          })
          const matched = pickAutoNavigateHref(pageLinks, beforeUrl || result.url, preferredName)
          throw new Error(
            [
              `click_noop: ref ${ref} did not change the page (no navigable href for this control).`,
              'Do NOT call browser_click on this ref again.',
              matched !== null
                ? `Next: browser_navigate to the matched link: ${matched}`
                : 'Next: browser_wait, browser_snapshot again, and use a ref that lists href=. Do not invent URLs. If still missing, ask the user for a direct content URL.',
              `url: ${result.url}`,
            ].join(' '),
          )
        }

        options.sessions.record({
          sessionId,
          tool: 'browser_click',
          summary: `Click ref ${ref}`,
          url: result.url,
          outcome: 'ok',
        })
        options.onMutation?.({ sessionId, tool: 'browser_click', url: result.url })
        return [
          `clicked ref ${ref}`,
          'changed: yes',
          `url: ${result.url}`,
          `title: ${result.title}`,
          resolvedHref !== '' ? `href: ${resolvedHref}` : null,
          warning !== '' ? `warning: ${warning}` : null,
          'Action: browser_snapshot, then browser_extract for page content (scroll first if needed). Do not keep opening more pages without a new goal.',
        ].filter(line => line !== null).join('\n')
      } catch (error) {
        noteHuman(sessionId, {}, error)
        if (!/click_noop:|click_blocked:/i.test(error instanceof Error ? error.message : String(error))) {
          options.sessions.record({
            sessionId,
            tool: 'browser_click',
            summary: `Click ref ${ref}`,
            url,
            outcome: 'error',
          })
        }
        throw error
      }
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'browser_type',
    'Type non-secret text into a ref from the latest browser_snapshot. Requires approval. NEVER type passwords, OTP/2FA codes, payment details, or captcha answers — call browser_ask_user and let the user type in the dedicated browser. Prefer textbox/input refs; refresh refs with browser_snapshot if stale. Typed values are masked in audit logs.',
    {
      ref: {
        type: 'number',
        required: true,
        description: 'Element ref from the latest browser_snapshot.',
      },
      text: {
        type: 'string',
        required: true,
        description: 'Non-secret text to type. Do not pass passwords or OTP codes.',
      },
    },
    async (args, exec) => {
      guardEnabled()
      const sessionId = sessionIdOf(exec)
      const ref = Number(args.ref)
      const text = String(args.text ?? '')
      if (!Number.isFinite(ref)) throw new Error('ref must be a number')
      await ensureConnected()
      await ensureSessionTab(sessionId)
      let url: string | undefined
      try {
        url = (await driverOf(options).pageStatus()).url
      } catch {
        url = undefined
      }
      requireFreshRef(sessionId, ref, 'browser_type')
      await requireMutation(exec, 'browser_type', `Type into ref ${ref}: ${maskTypeSummary(text)}`, url)
      try {
        const result = await runBridge(() => driverOf(options).type(ref, text))
        await rememberTab(sessionId, (result as { tabId?: number }).tabId)
        options.sessions.clearLastRefs(sessionId)
        options.sessions.record({
          sessionId,
          tool: 'browser_type',
          summary: `Type into ref ${ref}: ${maskTypeSummary(text)}`,
          url: result.url,
          outcome: 'ok',
        })
        options.onMutation?.({ sessionId, tool: 'browser_type', url: result.url })
        return `typed into ref ${ref}\nurl: ${result.url}\ntitle: ${result.title}\nAction: call browser_snapshot for fresh refs before the next click/type.`
      } catch (error) {
        noteHuman(sessionId, {}, error)
        options.sessions.record({
          sessionId,
          tool: 'browser_type',
          summary: `Type into ref ${ref}`,
          url,
          outcome: 'error',
        })
        throw error
      }
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'browser_scroll',
    'Scroll the bound page by dy pixels (positive = down). Use before browser_extract / browser_snapshot for below-the-fold content. Requires approval.',
    {
      dy: {
        type: 'number',
        required: true,
        description: 'Vertical scroll delta in pixels (e.g. 800–1400).',
      },
    },
    async (args, exec) => {
      guardEnabled()
      const sessionId = sessionIdOf(exec)
      const dy = Number(args.dy)
      if (!Number.isFinite(dy)) throw new Error('dy must be a number')
      await ensureConnected()
      await ensureSessionTab(sessionId)
      let url: string | undefined
      try {
        url = (await driverOf(options).pageStatus()).url
      } catch {
        url = undefined
      }
      await requireMutation(exec, 'browser_scroll', `Scroll by ${dy}px`, url)
      try {
        const result = await runBridge(() => driverOf(options).scroll(dy))
        await rememberTab(sessionId, (result as { tabId?: number }).tabId)
        options.sessions.record({
          sessionId,
          tool: 'browser_scroll',
          summary: `Scroll by ${dy}px`,
          url: result.url,
          outcome: 'ok',
        })
        options.onMutation?.({ sessionId, tool: 'browser_scroll', url: result.url })
        return `scrolled ${dy}px\nurl: ${result.url}\ntitle: ${result.title}\nAction: browser_extract or browser_snapshot next. Do not navigate away unless the user goal requires it.`
      } catch (error) {
        noteHuman(sessionId, {}, error)
        options.sessions.record({
          sessionId,
          tool: 'browser_scroll',
          summary: `Scroll by ${dy}px`,
          url,
          outcome: 'error',
        })
        throw error
      }
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'browser_extract',
    'Read visible page text from the dedicated browser (main/article/[role=main]/body). Use for comments, articles, tables, or any long content. Optional focus is echoed as a hint only — it does not select a site scraper. Prefer this over inventing content. Read-only; no approval. Auto-launches when disconnected.',
    {
      focus: {
        type: 'string',
        description: 'Optional hint for yourself (e.g. "comments", "pricing table"); returned in the tool result, not used to match CSS.',
      },
      maxChars: {
        type: 'number',
        description: 'Max characters to return (default 8000, max 20000).',
      },
    },
    async (args, exec) => {
      guardEnabled()
      const sessionId = sessionIdOf(exec)
      const focus = typeof args.focus === 'string' ? args.focus.trim() : ''
      const maxCharsRaw = Number(args.maxChars)
      const maxChars = Number.isFinite(maxCharsRaw) ? Math.min(Math.max(Math.floor(maxCharsRaw), 500), 20_000) : 8_000
      await ensureConnected()
      await ensureSessionTab(sessionId)
      try {
        let result = await runBridge(() => driverOf(options).extract({
          ...(focus === '' ? {} : { focus }),
          maxChars,
        }))
        await rememberTab(sessionId, result.tabId)
        const looksLoginGated = (text: string) => (
          /sign\s*in\s*to|log\s*in\s*to|请先登录|登录后(?:才能|可以|即可|查看)|captcha|验证码|人机验证/i.test(text)
        )
        // Soft hint alone is not enough — models often ignore it and spin. Auto-pause like snapshot.
        if (looksLoginGated(result.text)) {
          options.sessions.record({
            sessionId,
            tool: 'browser_extract',
            summary: focus === '' ? 'Extract needs human' : `Extract needs human (${focus})`,
            url: result.url,
            outcome: 'needs_human',
          })
          const prompt = [
            'Login or verification is required to read this page content (e.g. comments).',
            `Page: ${result.title || '(no title)'}`,
            `URL: ${result.url}`,
            'Finish login in the dedicated browser, then click “I’m done — continue”.',
          ].join(' ')
          const status = await pauseForHuman({
            sessionId,
            prompt,
            detail: `Login required for page content: ${result.title || result.url}`,
            url: result.url,
            tabId: result.tabId,
            signal: exec.signal,
          })
          if (status === 'cancelled') {
            throw new Error(
              'Human login wait was cancelled. Call browser_ask_user again when ready, or ask what they want next.',
            )
          }
          options.sessions.clearNeedsHuman(sessionId)
          result = await runBridge(() => driverOf(options).extract({
            ...(focus === '' ? {} : { focus }),
            maxChars,
          }))
          await rememberTab(sessionId, result.tabId)
        }
        const stillGated = looksLoginGated(result.text)
        if (stillGated) {
          options.sessions.setNeedsHuman(sessionId, 'Login or captcha required in the bound browser tab')
        }
        options.sessions.record({
          sessionId,
          tool: 'browser_extract',
          summary: focus === '' ? 'Extract page text' : `Extract page text (${focus})`,
          url: result.url,
          outcome: stillGated ? 'needs_human' : 'ok',
        })
        const lines = [
          `url: ${result.url}`,
          `title: ${result.title}`,
          focus !== '' ? `focus_hint: ${focus}` : null,
          `truncated: ${result.truncated ? 'yes' : 'no'}`,
          stillGated
            ? 'needs_human: true\nnote: still looks login-gated after human step — call browser_ask_user again or tell the user what is blocking.'
            : null,
          'text:',
          result.text,
          stillGated
            ? null
            : 'Action: Answer from this text when possible. If content is missing, browser_scroll then browser_extract again. Do not open unrelated pages.',
        ]
        return lines.filter(line => line !== null).join('\n')
      } catch (error) {
        noteHuman(sessionId, {}, error)
        options.sessions.record({
          sessionId,
          tool: 'browser_extract',
          summary: 'Extract page text',
          outcome: 'error',
        })
        throw error
      }
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'browser_screenshot',
    'Capture a PNG screenshot of the dedicated browser viewport (base64). Use to show the user a login/captcha wall or when refs are unclear — then call browser_ask_user so the run pauses until they finish. Prefer browser_snapshot for structure/refs. Read-only; no approval. Auto-launches when disconnected.',
    {},
    async (_args, exec) => {
      guardEnabled()
      const sessionId = sessionIdOf(exec)
      await ensureConnected()
      await ensureSessionTab(sessionId)
      const shot = await runBridge(() => driverOf(options).screenshot())
      await rememberTab(sessionId, (shot as { tabId?: number }).tabId)
      const truncated = shot.base64.length > 120_000
        ? `${shot.base64.slice(0, 120_000)}…(truncated)`
        : shot.base64
      return [
        `mime: ${shot.mime}`,
        `base64_chars: ${shot.base64.length}`,
        'note: If this shows login/captcha, call browser_ask_user next (do not keep clicking).',
        'base64:',
        truncated,
      ].join('\n')
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'browser_wait',
    'Wait until the bound tab finishes loading, or until page text matches (case-insensitive substring). Read-only; no approval. Use after navigate/click on slow pages.',
    {
      timeoutMs: {
        type: 'number',
        description: 'Max wait in milliseconds (200–60000). Default 8000.',
      },
      text: {
        type: 'string',
        description: 'Optional substring to wait for in title + body text.',
      },
    },
    async (args, exec) => {
      guardEnabled()
      const sessionId = sessionIdOf(exec)
      await ensureConnected()
      await ensureSessionTab(sessionId)
      const timeoutMs = args.timeoutMs === undefined ? undefined : Number(args.timeoutMs)
      const text = args.text === undefined ? undefined : String(args.text)
      const result = await runBridge(() => driverOf(options).wait({
        ...(timeoutMs === undefined || !Number.isFinite(timeoutMs) ? {} : { timeoutMs }),
        ...(text === undefined || text.trim() === '' ? {} : { text }),
      }))
      await rememberTab(sessionId, result.tabId)
      return [
        `matched: ${result.matched ? 'yes' : 'no'}`,
        `url: ${result.url}`,
        `title: ${result.title}`,
        result.tabId !== undefined ? `tabId: ${result.tabId}` : null,
      ].filter(line => line !== null).join('\n')
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'browser_list_tabs',
    'List open browser tabs (id, title, url, active, bound). Read-only; no approval. Use with browser_follow_tab to bind this session to another tab.',
    {},
    async (_args, exec) => {
      guardEnabled()
      const sessionId = sessionIdOf(exec)
      await ensureConnected()
      const body = await runBridge(() => driverOf(options).listTabs())
      const sessionBound = options.sessions.tabOf(sessionId)
      const lines = [
        `sessionBoundTabId: ${sessionBound ?? 'none'}`,
        `extensionBoundTabId: ${body.boundTabId ?? 'none'}`,
        'tabs:',
        ...body.tabs.slice(0, 40).map(tab => (
          `- [${tab.tabId}]${tab.bound ? ' (bound)' : ''}${tab.active ? ' (active)' : ''} ${JSON.stringify(tab.title)} ${tab.url}`
        )),
      ]
      return lines.join('\n')
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'browser_follow_tab',
    'Bind later browser_* tools for this session to a tabId from browser_list_tabs. Does not activate the tab unless activate=true. Requires approval when activating or leaving the previous bound tab.',
    {
      tabId: {
        type: 'number',
        required: true,
        description: 'Tab id from browser_list_tabs.',
      },
      activate: {
        type: 'boolean',
        description: 'When true, bring the tab to the front.',
      },
    },
    async (args, exec) => {
      guardEnabled()
      const sessionId = sessionIdOf(exec)
      const tabId = Number(args.tabId)
      const activate = args.activate === true
      if (!Number.isFinite(tabId)) throw new Error('tabId must be a number')
      await ensureConnected()
      let url: string | undefined
      try {
        const listed = await driverOf(options).listTabs()
        url = listed.tabs.find(tab => tab.tabId === tabId)?.url
      } catch {
        url = undefined
      }
      await requireMutation(
        exec,
        'browser_follow_tab',
        `Follow tab ${tabId}${activate ? ' (activate)' : ''}`,
        url,
      )
      const result = await runBridge(() => driverOf(options).followTab(tabId, activate))
      await rememberTab(sessionId, result.tabId)
      options.sessions.clearConflict(sessionId)
      options.sessions.record({
        sessionId,
        tool: 'browser_follow_tab',
        summary: `Follow tab ${tabId}`,
        url: result.url,
        outcome: 'ok',
      })
      options.onMutation?.({ sessionId, tool: 'browser_follow_tab', url: result.url })
      return `following tab ${result.tabId}\nurl: ${result.url}\ntitle: ${result.title}`
    },
  )))

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // ignore
      }
    }
  }
}
