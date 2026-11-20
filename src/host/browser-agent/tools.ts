import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserApprovalGate } from './approval.ts'
import type { BrowserDriver } from './driver.ts'
import type { BrowserHumanGate } from './human-gate.ts'
import { pickAutoNavigateHref, pathsDiffer } from './auto-nav.ts'
import type { SnapshotBody } from './protocol.ts'
import type { BrowserSessionState } from './session-state.ts'
import type { TabScopeStore } from './tab-scope.ts'
import type { Diagnosis } from './diagnose.ts'
import { demoTabLegend, describeDemoStep, summarizeDemoSteps, type DemoStep } from './demo.ts'
import { applyRecipeVars, prepareRecipeValues, type DemoRecipeStore } from './demo-recipes.ts'
import { normalizeControlName, replayDemoSteps } from './demo-replay.ts'
import type { BrowserRepairHooks, DemoObservedAction } from './demo-heal.ts'

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
    body.harvest === undefined
      ? null
      : `harvest: interactive=${body.harvest.interactive} controls=${body.harvest.controls} anchors=${body.harvest.anchors}`,
    body.emulation === undefined
      ? null
      : `emulation: ${[
        body.emulation.colorScheme === undefined ? null : `colorScheme=${body.emulation.colorScheme}`,
        body.emulation.reducedMotion === undefined ? null : `reducedMotion=${body.emulation.reducedMotion}`,
        body.emulation.viewport === undefined ? null : `viewport=${body.emulation.viewport.width}x${body.emulation.viewport.height}`,
      ].filter((part): part is string => part !== null).join(' ')}`,
    typeof body.note === 'string' && body.note.trim() !== '' ? `note: ${body.note.trim()}` : null,
    ...(extra ?? []),
    (() => {
      const links = body.nodes.filter(node => node.tag === 'a').length
      const controls = body.nodes.length - links
      const shown = body.nodes.length
      const tally = controls > 0 ? `${links} link / ${controls} control` : `${links} link`
      return controls > 0
        ? `interactive (${shown} shown: ${tally} — controls listed first; prefer refs that include href=… ; never invent URLs; re-snapshot after navigation):`
        : `interactive (${shown} shown: ${tally}; prefer refs that include href=… ; never invent URLs; re-snapshot after navigation):`
    })(),
    ...body.nodes.slice(0, 80).map(node => (
      `- [${node.ref}] ${node.role}${node.tag !== undefined ? `/${node.tag}` : ''}${node.sensitive === true ? ' [sensitive]' : ''}${typeof node.href === 'string' && node.href !== '' ? ` href=${JSON.stringify(node.href)}` : ''} ${JSON.stringify(node.name)}`
    )),
    'text_preview (short — use browser_extract for long/below-fold content):',
    body.textPreview.slice(0, 2_000),
  ]
  return lines.filter(line => line !== null).join('\n')
}

/**
 * Mutating browser tools carry a `label` copied from the snapshot. It is the
 * only thing the official permission reviewer (auto-review) can read about the
 * action, so it must describe this ref — a paraphrase is tolerated, a different
 * control is not.
 */
function requireControlLabel(input: {
  readonly label: unknown
  readonly ref: number
  readonly actual: string
  readonly tool: string
}): string {
  const label = typeof input.label === 'string' ? input.label.trim() : ''
  const actual = input.actual.trim()
  if (actual === '') return label
  if (label === '') {
    throw new Error(
      `label is required for ${input.tool}: ref ${input.ref} is ${JSON.stringify(actual)}. `
      + `Pass label: ${JSON.stringify(actual)} (copy it from the latest browser_snapshot); the permission reviewer sees only your arguments.`,
    )
  }
  const wanted = normalizeControlName(actual)
  const given = normalizeControlName(label)
  const compatible = given === wanted
    || (given.length >= 2 && wanted.length >= 2 && (given.includes(wanted) || wanted.includes(given)))
  if (!compatible) {
    throw new Error(
      `label ${JSON.stringify(label)} does not match ref ${input.ref} (${JSON.stringify(actual)}). `
      + 'Copy the control name from the latest browser_snapshot; a wrong label would be reviewed as a different action.',
    )
  }
  return label
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

/**
 * How a mutating browser call is allowed:
 * - `full`: the session preset already granted full access — do not ask;
 * - `ask`: workspace-write / unknown — show our card (the browser sits outside
 *   the workspace, so the preset itself has no opinion);
 * - `read-only`: refuse, do not pretend asking would help.
 */
export type BrowserPermissionMode = 'full' | 'ask' | 'read-only'

/**
 * Map an official permission preset onto what a browser mutation needs.
 * `auto` means the per-call reviewer in `tools/pre-execute` already decided, so
 * asking again would duplicate it; `custom` has unknown knobs, so ask.
 */
export function browserPermissionFromPreset(preset: unknown): BrowserPermissionMode | undefined {
  if (preset === 'danger-full-access' || preset === 'auto') return 'full'
  if (preset === 'read-only') return 'read-only'
  if (preset === 'workspace-write') return 'ask'
  return undefined
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
  /** Per-tab write guard shared with the sidebar toggle. */
  readonly tabScope?: TabScopeStore
  /** Debug tools switch (browser_network / browser_console / browser_emulate). */
  readonly debugTools?: () => boolean
  /** "Show me" recorder switch (browser_demonstrate). */
  readonly demonstrate?: () => boolean
  /** Last completed recording, whoever stopped it (agent or sidebar). */
  readonly onDemonstration?: (steps: readonly DemoStep[]) => void
  /**
   * What the official permission preset says about this session. The browser is
   * outside the workspace, so the preset cannot decide for us — but it must be
   * honoured: full access must not be asked again, read-only must be refused.
   * Undefined means the host has no preset service (older build): keep asking.
   */
  readonly permission?: (session: unknown) => BrowserPermissionMode | undefined
  /** Saved demonstration flows (see demo-recipes.ts). */
  readonly recipes?: DemoRecipeStore
  /**
   * Repair tracking: started when a saved flow stops, closed by the next flow
   * run or an explicit `heal`. Without it the agent still finishes by hand, the
   * flow just never learns.
   */
  readonly repair?: BrowserRepairHooks
  /** What is wrong (if anything) and the concrete next step. */
  readonly diagnosis?: () => Diagnosis
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

/**
 * How the snapshot describes a ref, captured before the action mutates the page.
 * Free when no repair is watching, which is almost always.
 */
async function captureRefEvidence(
  options: BrowserToolsOptions,
  ref: number,
): Promise<{ readonly role: string; readonly name: string; readonly selector: string } | null> {
  if (options.repair?.active() !== true) return null
  const driver = driverOf(options)
  if (typeof driver.refInfo !== 'function') return null
  const info = await driver.refInfo(ref).catch(() => null)
  if (info === null) return null
  return { role: info.role, name: info.name, selector: info.selector }
}

function recordRepair(
  options: BrowserToolsOptions,
  evidence: { readonly role: string; readonly name: string; readonly selector: string } | null,
  kind: DemoObservedAction['kind'],
  extra: { readonly value?: string; readonly url?: string; readonly tabId?: number } = {},
): void {
  if (options.repair?.active() !== true) return
  options.repair.observe({
    kind,
    at: Date.now(),
    ...(evidence === null ? {} : evidence),
    ...(evidence === null || kind !== 'fill' ? {} : { field: evidence.name }),
    ...(extra.value === undefined ? {} : { value: extra.value }),
    ...(extra.url === undefined ? {} : { url: extra.url }),
    ...(extra.tabId === undefined ? {} : { tabId: extra.tabId }),
  })
}

/** Narrow a string arg to a known enum, or throw with the allowed values. */
function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const text = String(value).trim().toLowerCase()
  if (!(allowed as readonly string[]).includes(text)) {
    throw new Error(`${field} must be one of: ${allowed.join(' | ')}`)
  }
  return text as T
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

  /** Demonstration recording is opt-in: it observes what the user does. */
  const requireDemonstrate = () => {
    if (options.demonstrate?.() === true) return
    throw new Error(
      'browser_demonstrate: demonstration recording is off. Nothing is recording. '
      + 'Ask the user to enable 设置 → 智能体增强 → 功能 → 浏览器 Agent → 演示录制, then retry.',
    )
  }

  /** Debug tools are opt-in: the switch gates all three, capture included. */
  const requireDebugTools = (tool: string) => {
    if (options.debugTools?.() === true) return
    // Turning the switch off must also stop recording, not just refuse calls.
    try {
      driverOf(options).stopCapture?.()
    } catch {
      // No driver mounted yet — nothing is recording.
    }
    throw new Error(
      `${tool}: debug tools are off. Nothing ran. `
      + 'Ask the user to enable 设置 → 智能体增强 → 功能 → 浏览器 Agent → 调试与页面模拟, then retry.',
    )
  }

  /**
   * Read-only tab: refuse the mutation before any dialog or page op, so a run on
   * a sensitive tab fails fast instead of prompting on every click.
   */
  const requireWritableTab = (sessionId: string, tool: string) => {
    const scope = options.tabScope
    if (scope === undefined) return
    const tabId = options.sessions.tabOf(sessionId)
    if (tabId === undefined || !scope.isReadOnly(tabId)) return
    options.sessions.record({
      sessionId,
      tool,
      summary: `Blocked: tab ${tabId} is read-only`,
      outcome: 'denied',
    })
    throw new Error(scope.refusal(tabId))
  }

  const requireMutation = async (
    exec: ToolExec,
    tool: string,
    summary: string,
    url: string | undefined,
    targetRef?: number,
  ) => {
    const sessionId = sessionIdOf(exec)
    const permission = options.permission?.(exec.agent?.session) ?? 'ask'
    if (permission === 'read-only') {
      options.sessions.record({
        sessionId,
        tool,
        summary,
        ...(url === undefined ? {} : { url }),
        outcome: 'denied',
      })
      throw new Error(
        '会话权限是「仅可查看」，浏览器变更被拒绝。'
        + '把权限切到「工作区内修改」或「完全权限」后再试。',
      )
    }
    if (permission === 'full') {
      // The user already granted full access for this session: asking again is
      // the bug this branch removes.
      return
    }
    // Prefer a real http(s) URL so allow-origin can stick for the session.
    // pageStatus may be about:blank / empty right after launch — fall back to last known.
    let effectiveUrl = typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined
    if (effectiveUrl === undefined) {
      effectiveUrl = options.sessions.lastHttpUrl(sessionId)
    } else {
      options.sessions.rememberHttpUrl(sessionId, effectiveUrl)
    }
    // Show what the card is about: a small crop of the control being acted on.
    // Older/fake drivers may not implement thumbnail(); treat that as "no preview".
    const thumbDriver = driverOf(options)
    const thumbnail = targetRef === undefined || typeof thumbDriver.thumbnail !== 'function'
      ? null
      : await thumbDriver.thumbnail(targetRef).catch(() => null)
    const decision = await options.approval.requestApproval({
      sessionId,
      tool,
      summary,
      url: effectiveUrl,
      signal: exec.signal,
      ...(thumbnail === null ? {} : { thumbnail }),
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
    readonly kind?: 'human' | 'ask'
    readonly url?: string
    readonly tabId?: number
    readonly signal: AbortSignal
  }): Promise<'continued' | 'cancelled'> => {
    options.sessions.setNeedsHuman(input.sessionId, input.detail, input.kind ?? 'human')
    await focusBoundTab(input.sessionId, input.tabId)
    try {
      return await options.human.waitForHuman({
        sessionId: input.sessionId,
        prompt: input.prompt,
        detail: input.detail,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
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
    // Refs are unique per driver and kept with their tab, so a misplaced ref can
    // name its real tab instead of a generic "call browser_snapshot".
    const active = options.sessions.tabOf(sessionId)
    const owner = options.sessions.tabHoldingRef(ref, active)
    if (owner !== undefined) {
      throw new Error(
        `${tool}: ref ${ref} belongs to tab ${owner}, but tab ${active ?? 'none'} is active. `
        + `Switch back with browser_follow_tab (tabId ${owner}) — that tab's refs are still valid — `
        + 'or call browser_snapshot to get refs for the current tab.',
      )
    }
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
    'Check the Desktop dedicated browser (Mac: Safari/Chrome; Windows: Chrome/Edge): whether it is usable, the bound tab URL/title/tabId, and — when something is wrong — the concrete next step. Use this for any real-browser / webpage / on-page task. Auto-launches the dedicated browser when disconnected — do not ask the user to launch manually first.',
    {},
    async (_args, exec) => {
      guardEnabled()
      const sessionId = sessionIdOf(exec)
      const diag = options.diagnosis?.()
      const diagLines = diag === undefined
        ? []
        : [
          `diagnosis: ${diag.code}`,
          `next: ${diag.nextStep}`,
          diag.detail === undefined ? null : `detail: ${diag.detail}`,
        ].filter((line): line is string => line !== null)
      const st = driverOf(options).status()
      if (!st.listening || !st.ready) {
        try {
          await ensureConnected()
        } catch (error) {
          return [
            `driver: ${st.kind}`,
            `browser: ${st.listening ? 'listening, not ready' : 'not started'}`,
            st.endpoint !== undefined ? `endpoint: ${st.endpoint}` : null,
            ...diagLines,
            formatBridgeError(error),
          ].filter((line): line is string => line !== null).join('\n')
        }
      }
      try {
        await ensureSessionTab(sessionId)
        const tab = await runBridge(() => driverOf(options).pageStatus())
        await rememberTab(sessionId, tab.tabId)
        return [
          `driver: ${driverOf(options).kind}`,
          'browser: ready',
          ...diagLines,
          `url: ${tab.url}`,
          `title: ${tab.title}`,
          `tabId: ${tab.tabId}`,
          `sessionBound: ${options.sessions.tabOf(sessionId) === tab.tabId ? 'yes' : 'no'}`,
          `bound: ${tab.bound === false ? 'no' : 'yes'}`,
          tab.rebound === true ? 'note: rebound to focused tab' : null,
          tab.conflict === true ? 'note: tab focus conflict pending' : null,
        ].filter((line): line is string => line !== null).join('\n')
      } catch (error) {
        noteHuman(sessionId, {}, error)
        return [
          `driver: ${driverOf(options).kind}`,
          'browser: ready, status call failed',
          ...diagLines,
          formatBridgeError(error),
        ].join('\n')
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
        // A generic "do this in the browser" request must not wear the login card.
        kind: 'ask',
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
      // Opening a fresh tab is the documented escape hatch from a read-only tab.
      if (!newTab) requireWritableTab(sessionId, 'browser_navigate')
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
        if (options.repair?.active() === true) {
          const tabId = options.sessions.tabOf(sessionId)
          options.repair.observe({
            kind: 'navigate',
            at: Date.now(),
            url: result.url,
            ...(tabId === undefined ? {} : { tabId }),
          })
        }
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
    'Click an interactive element by ref from the latest browser_snapshot. Requires approval. Pass label (the control name from the snapshot) so the permission reviewer can judge what will be clicked. If the ref is missing/stale, browser_snapshot first. Dead clicks may follow that same ref’s http(s) href only — never invent other URLs. Do NOT use this to submit passwords or solve captchas — call browser_ask_user instead. Auto-launches when disconnected.',
    {
      ref: {
        type: 'number',
        required: true,
        description: 'Element ref from the latest browser_snapshot.',
      },
      label: {
        type: 'string',
        description: 'The control name exactly as browser_snapshot shows it (e.g. "导出报表"). Required whenever the control has a name; the permission reviewer sees only this.',
      },
    },
    async (args, exec) => {
      guardEnabled()
      const sessionId = sessionIdOf(exec)
      const ref = Number(args.ref)
      if (!Number.isFinite(ref)) throw new Error('ref must be a number')
      await ensureConnected()
      await ensureSessionTab(sessionId)
      requireWritableTab(sessionId, 'browser_click')
      let url: string | undefined
      try {
        url = (await driverOf(options).pageStatus()).url
      } catch {
        url = undefined
      }
      requireFreshRef(sessionId, ref, 'browser_click')
      requireControlLabel({
        label: args.label,
        ref,
        actual: options.sessions.nameOfRef(sessionId, ref) ?? '',
        tool: 'browser_click',
      })
      // Read the control's identity before the click: after a navigation the
      // snapshot that owned this ref is gone.
      const repairEvidence = await captureRefEvidence(options, ref)
      if (options.sessions.isDeadClickRef(sessionId, ref)) {
        throw new Error(
          `click_blocked: ref ${ref} already failed with no navigation. `
          + 'Do NOT browser_click it again. browser_navigate to a content URL, or browser_snapshot and use a ref that lists href=.',
        )
      }
      const snapshotHref = options.sessions.hrefOfRef(sessionId, ref)
      await requireMutation(exec, 'browser_click', `Click ref ${ref}`, url, ref)
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

        // Evidence goes in before the no-op check: an export button often starts a
        // download without changing the URL, and that click is still the repair.
        recordRepair(options, repairEvidence, 'click', {
          url: result.url,
          tabId: options.sessions.tabOf(sessionId),
        })
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
    'Type non-secret text into a ref from the latest browser_snapshot. Requires approval. Pass label (the field name from the snapshot) so the permission reviewer can judge where the text goes. NEVER type passwords, OTP/2FA codes, payment details, or captcha answers — call browser_ask_user and let the user type in the dedicated browser. Prefer textbox/input refs; refresh refs with browser_snapshot if stale. Typed values are masked in audit logs.',
    {
      ref: {
        type: 'number',
        required: true,
        description: 'Element ref from the latest browser_snapshot.',
      },
      label: {
        type: 'string',
        description: 'The field name exactly as browser_snapshot shows it (e.g. "开始日期"). Required whenever the field has a name.',
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
      requireWritableTab(sessionId, 'browser_type')
      let url: string | undefined
      try {
        url = (await driverOf(options).pageStatus()).url
      } catch {
        url = undefined
      }
      requireFreshRef(sessionId, ref, 'browser_type')
      requireControlLabel({
        label: args.label,
        ref,
        actual: options.sessions.nameOfRef(sessionId, ref) ?? '',
        tool: 'browser_type',
      })
      const repairEvidence = await captureRefEvidence(options, ref)
      await requireMutation(exec, 'browser_type', `Type into ref ${ref}: ${maskTypeSummary(text)}`, url, ref)
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
        recordRepair(options, repairEvidence, 'fill', {
          value: text,
          url: result.url,
          tabId: options.sessions.tabOf(sessionId),
        })
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
    'browser_network',
    'Read buffered network activity for the bound tab (method, url, status, duration, failures). Read-only; no approval. Defaults to the bound tab; pass allTabs: true to include other tabs. Headers, cookies and bodies are never recorded; secret-looking query values are masked. Requires the Debug tools switch in Settings → 智能体增强 → 浏览器 Agent. Capture starts automatically when that switch is on, so navigate first, then read.',
    {
      limit: {
        type: 'number',
        description: 'Newest N entries (default 40, max 200).',
      },
      allTabs: {
        type: 'boolean',
        description: 'Read every tab instead of only the bound tab.',
      },
      clear: {
        type: 'boolean',
        description: 'Drop the returned entries from the buffer.',
      },
    },
    async (args, exec) => {
      guardEnabled()
      requireDebugTools('browser_network')
      const sessionId = sessionIdOf(exec)
      await ensureConnected()
      await ensureSessionTab(sessionId)
      const limit = Number(args.limit)
      const tabId = options.sessions.tabOf(sessionId)
      const allTabs = args.allTabs === true || tabId === undefined
      const driver = driverOf(options)
      driver.startCapture()
      const { entries, dropped, skipped } = driver.readCapture({
        kind: 'network',
        ...(Number.isFinite(limit) ? { limit } : {}),
        ...(args.clear === true ? { clear: true } : {}),
        ...(allTabs ? {} : { tabId: tabId as number }),
      })
      const rows = entries.filter(entry => entry.kind === 'request')
      if (rows.length === 0) {
        return [
          allTabs ? 'no network activity buffered yet.' : `no network activity buffered for tab ${tabId ?? '?'}.`,
          ...(skipped > 0 ? [`${skipped} entries came from other tabs — pass allTabs: true to read them.`] : []),
          'Navigate or wait for the page to load, then call browser_network again.',
        ].join('\n')
      }
      return [
        `network entries: ${rows.length} (${allTabs ? 'all tabs' : `tab ${tabId}`})${dropped > 0 ? ` (${dropped} older dropped)` : ''}`,
        ...(skipped > 0 ? [`${skipped} entries from other tabs not shown — pass allTabs: true to include them.`] : []),
        ...rows.map(entry => {
          const status = entry.kind !== 'request' ? '' : (entry.status === undefined ? (entry.failure ?? 'failed') : String(entry.status))
          const ms = entry.kind === 'request' && entry.durationMs !== undefined ? ` ${entry.durationMs}ms` : ''
          const method = entry.kind === 'request' ? entry.method : 'GET'
          return `- [${entry.tabId}] ${status} ${method} ${entry.kind === 'request' ? entry.url : ''}${ms}`
        }),
      ].join('\n')
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'browser_console',
    'Read buffered console messages and uncaught page errors for the bound tab. Read-only; no approval. Defaults to the bound tab; pass allTabs: true to include other tabs. Requires the Debug tools switch in Settings → 智能体增强 → 浏览器 Agent.',
    {
      limit: {
        type: 'number',
        description: 'Newest N entries (default 40, max 200).',
      },
      allTabs: {
        type: 'boolean',
        description: 'Read every tab instead of only the bound tab.',
      },
      clear: {
        type: 'boolean',
        description: 'Drop the returned entries from the buffer.',
      },
    },
    async (args, exec) => {
      guardEnabled()
      requireDebugTools('browser_console')
      const sessionId = sessionIdOf(exec)
      await ensureConnected()
      await ensureSessionTab(sessionId)
      const limit = Number(args.limit)
      const tabId = options.sessions.tabOf(sessionId)
      const allTabs = args.allTabs === true || tabId === undefined
      const driver = driverOf(options)
      driver.startCapture()
      const { entries, skipped } = driver.readCapture({
        kind: 'console',
        ...(Number.isFinite(limit) ? { limit } : {}),
        ...(args.clear === true ? { clear: true } : {}),
        ...(allTabs ? {} : { tabId: tabId as number }),
      })
      if (entries.length === 0) {
        return [
          allTabs ? 'no console output buffered yet.' : `no console output buffered for tab ${tabId ?? '?'}.`,
          ...(skipped > 0 ? [`${skipped} entries came from other tabs — pass allTabs: true to read them.`] : []),
          'Reload or interact with the page, then call browser_console again.',
        ].join('\n')
      }
      return [
        `console entries: ${entries.length} (${allTabs ? 'all tabs' : `tab ${tabId}`})`,
        ...(skipped > 0 ? [`${skipped} entries from other tabs not shown — pass allTabs: true to include them.`] : []),
        ...entries.map(entry => {
          if (entry.kind !== 'console') return ''
          const where = entry.location === undefined ? '' : ` (${entry.location})`
          return `- [${entry.tabId}] ${entry.level}: ${entry.text}${where}`
        }),
      ].filter(line => line !== '').join('\n')
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'browser_emulate',
    'Change how the bound page renders for testing: color scheme, reduced motion, viewport size. Read-only on page data; no approval. Requires the Debug tools switch in Settings → 智能体增强 → 浏览器 Agent. Call browser_snapshot afterwards to see the effect.',
    {
      colorScheme: {
        type: 'string',
        description: 'light | dark | no-preference | reset',
      },
      reducedMotion: {
        type: 'string',
        description: 'reduce | no-preference | reset',
      },
      width: {
        type: 'number',
        description: 'Viewport width in CSS px (320–3840).',
      },
      height: {
        type: 'number',
        description: 'Viewport height in CSS px (240–2160).',
      },
    },
    async (args, exec) => {
      guardEnabled()
      requireDebugTools('browser_emulate')
      const sessionId = sessionIdOf(exec)
      const colorScheme = pickEnum(args.colorScheme, ['light', 'dark', 'no-preference', 'reset'] as const, 'colorScheme')
      const reducedMotion = pickEnum(args.reducedMotion, ['reduce', 'no-preference', 'reset'] as const, 'reducedMotion')
      const width = Number(args.width)
      const height = Number(args.height)
      const hasViewport = Number.isFinite(width) && Number.isFinite(height)
      if (colorScheme === undefined && reducedMotion === undefined && !hasViewport) {
        throw new Error('browser_emulate: pass colorScheme, reducedMotion, or width+height')
      }
      await ensureConnected()
      await ensureSessionTab(sessionId)
      const result = await runBridge(() => driverOf(options).emulate({
        ...(colorScheme === undefined ? {} : { colorScheme }),
        ...(reducedMotion === undefined ? {} : { reducedMotion }),
        ...(hasViewport ? { viewport: { width, height } } : {}),
      }))
      await rememberTab(sessionId, result.tabId)
      return [
        `emulated: ${result.applied.join(', ')}`,
        `url: ${result.url}`,
        `title: ${result.title}`,
        result.tabId !== undefined ? `tabId: ${result.tabId}` : null,
        'Action: browser_snapshot now echoes the emulation line, so you can confirm the mode the page is in.',
      ].filter(line => line !== null).join('\n')
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'browser_demonstrate',
    'Ask the user to show you a flow in the dedicated browser window (they click and type, you watch), blocking until they press Continue. Records clicks, filled fields, Enter presses, top-level navigations and single-page-app route changes in every tab of that browser; each step is tagged with the tab it happened in. Password / OTP / token fields are masked as ***. Use it when you cannot work out how a flow works. Returns numbered steps to replay with browser_snapshot then browser_click / browser_type by name (refs change between runs), or pass replay: true to run the recorded flow immediately. Requires the Demonstrate switch in Settings → 智能体增强 → 浏览器 Agent.',
    {
      message: {
        type: 'string',
        required: true,
        description: 'What to show, in the user\'s language, e.g. "Show me how you export the report, then click Continue."',
      },
      timeoutMs: {
        type: 'number',
        description: 'How long to wait for the user, in ms (default 300000).',
      },
      replay: {
        type: 'boolean',
        description: 'Run the recorded flow once right after the user finishes (default false). Replay is by role + name against a fresh snapshot; a masked secret, a <select>, or a control that is gone stops it at that step and returns what is left.',
      },
    },
    async (args, exec) => {
      guardEnabled()
      requireDemonstrate()
      const sessionId = sessionIdOf(exec)
      const message = String(args.message ?? '').trim()
      if (message === '') throw new Error('message is required')
      const timeoutRaw = Number(args.timeoutMs)
      const timeoutMs = Number.isFinite(timeoutRaw)
        ? Math.min(Math.max(Math.trunc(timeoutRaw), 30_000), 900_000)
        : HUMAN_WAIT_TIMEOUT_MS
      await ensureConnected()
      await ensureSessionTab(sessionId)
      const driver = driverOf(options)
      const tabId = options.sessions.tabOf(sessionId)
      await driver.startDemonstration()
      options.sessions.record({
        sessionId,
        tool: 'browser_demonstrate',
        summary: message.slice(0, 160),
        outcome: 'needs_human',
      })
      const status = await pauseForHuman({
        sessionId,
        prompt: message,
        detail: message.slice(0, 240),
        kind: 'ask',
        ...(tabId === undefined ? {} : { tabId }),
        signal: exec.signal,
      })
      const steps = await driver.stopDemonstration().catch(() => [])
      if (status === 'cancelled') {
        return 'user_ack: cancelled\nAction: the demonstration was cancelled. Ask what they want next.'
      }
      if (steps.length > 0) options.onDemonstration?.(steps)
      const summary = summarizeDemoSteps(steps)
      options.sessions.record({
        sessionId,
        tool: 'browser_demonstrate',
        summary: `Demonstrated ${summary.shown} step(s)${summary.multiTab ? ` across ${summary.tabs.length} tabs` : ''}`,
        outcome: 'ok',
      })
      if (summary.shown === 0) {
        return [
          'demonstrated steps: 0',
          'Nothing was recorded — the user may have pressed Continue without acting.',
          'Action: call browser_ask_user to check, or browser_snapshot and continue on your own.',
        ].join('\n')
      }
      const heading = `demonstrated steps: ${summary.shown}${steps.length > summary.shown ? ` (of ${steps.length})` : ''}`
      const maskedLine = summary.masked > 0
        ? [`masked fields: ${summary.masked} (secret values are never shown)`]
        : []
      if (args.replay === true) {
        const replay = await replayDemoSteps(driver, steps).catch((error: unknown) => ({
          status: 'blocked' as const,
          performed: 0,
          total: steps.length,
          lines: [] as string[],
          reason: error instanceof Error ? error.message : String(error),
          pending: steps,
        }))
        options.sessions.record({
          sessionId,
          tool: 'browser_demonstrate',
          summary: `Replayed ${replay.performed}/${replay.total} demonstrated step(s)`,
          outcome: replay.status === 'done' ? 'ok' : 'error',
        })
        if (replay.status === 'done') {
          return [
            `${heading} — replayed ${replay.performed}/${replay.total}`,
            ...maskedLine,
            ...demoTabLegend(summary),
            ...replay.lines,
            `url: ${replay.url}`,
            'Action: the recorded flow ran to the end. Report what changed on screen; call browser_snapshot if you need the new page.',
          ].join('\n')
        }
        const pendingLines = replay.pending.map((step, offset) => {
          const n = replay.performed + offset + 1
          const tag = summary.multiTab && step.tabId !== undefined ? `[tab ${step.tabId}] ` : ''
          return `${n}. todo ${tag}${describeDemoStep(step)}`
        })
        return [
          `${heading} — replayed ${replay.performed}/${replay.total}`,
          ...maskedLine,
          ...demoTabLegend(summary),
          ...replay.lines,
          `stopped at step ${replay.performed + 1}: ${replay.reason}`,
          ...pendingLines,
          'Action: the replay stopped, so the page is whatever the last ok step left behind. Do the remaining steps yourself with browser_snapshot then browser_click / browser_type (role+name), or browser_ask_user if a secret or an unusual control is in the way. Do not claim the flow finished.',
        ].join('\n')
      }
      return [
        heading,
        ...maskedLine,
        ...demoTabLegend(summary),
        ...summary.lines,
        summary.multiTab
          ? 'Action: the flow crossed tabs. browser_list_tabs, then browser_follow_tab for each tab N before acting in it (match by URL; ids are stable while this browser stays open). In each tab: browser_snapshot, then browser_click / browser_type by the role+name shown here. Refs change between runs; never invent selectors.'
          : 'Action: replay with browser_snapshot, then browser_click / browser_type by the role+name shown here. Refs change between runs; never invent selectors.',
      ].join('\n')
    },
    HUMAN_WAIT_TIMEOUT_MS,
  )))

  disposers.push(ctx.tools.register(textTool(
    'browser_demo_recipes',
    'List, run, or repair a flow the user saved from a demonstration (right sidebar → 演示录制 → 保存为流程). Use it when the user names a saved flow ("跑一下「周报导出」流程") or asks which flows exist. Running replays the recorded steps in the dedicated browser; it asks for approval once and stops at a masked secret or a control that is gone, exactly like browser_demonstrate replay. When it stops because a control changed, finish the remaining steps yourself, then call action=heal so the user can keep the fix. A flow that still needs a value says which ones by their label: ask the user one short question ("这次开始日期用哪天？") and run again with vars. Do not ask for values the recording already fixed.',
    {
      action: {
        type: 'string',
        required: true,
        description: '"list" to show saved flows, "run" to replay one, "heal" to offer the fix you just worked out.',
      },
      name: {
        type: 'string',
        description: 'Flow name for action=run. Case-insensitive; a unique part of the name is enough.',
      },
      id: {
        type: 'string',
        description: 'Flow id for action=heal; omit to use the flow that just stopped.',
      },
      accept: {
        type: 'boolean',
        description: 'action=heal: apply the repair to the saved flow now (the user asked to remember it). Default false: offer it in the sidebar.',
      },
      site: {
        type: 'string',
        description: 'action=run: the origin shown by action=list (e.g. https://example.com). Pass it so the permission reviewer can see which site the flow touches; a mismatch is rejected.',
      },
      vars: {
        type: 'object',
        additionalProperties: true,
        description: 'Values for the flow\'s variables, keyed by the label the user sees (\'{"开始日期":"2026-11-01"}\') or by id. Dates may be relative: 今天 / 上周 / 上月 / 上季度 / 2026-11-01. Saved defaults are used for anything omitted.',
      },
    },
    async (args, exec) => {
      guardEnabled()
      requireDemonstrate()
      const store = options.recipes
      if (store === undefined) throw new Error('recipe store unavailable')
      const action = String(args.action ?? '').trim().toLowerCase()
      const rows = store.list()
      if (action === 'list') {
        // Close a repair the agent finished but never asked about, so the panel
        // can offer it instead of losing it.
        options.repair?.commit()
        const afterCommit = store.list()
        if (afterCommit.length === 0) {
          return 'saved flows: 0\nAction: none yet — the user can record a demonstration and save it in the sidebar, then retry.'
        }
        return [
          `saved flows: ${afterCommit.length}`,
          ...afterCommit.map(row => {
            const vars = row.variables.length === 0 ? '' : `; vars: ${row.variables.map(variable => variable.name).join(', ')}`
            const heal = row.pendingHeal === undefined ? '' : `; repair waiting: step ${row.pendingHeal.failedAt}`
            const auto = row.autoHeals === 0 ? '' : `; auto-adapted ${row.autoHeals}x`
            const site = row.site === undefined ? '' : `; site: ${row.site}`
            return `- ${row.name} (${row.steps} step(s)${vars}${heal}${auto}${site})`
          }),
          'Action: run one with browser_demo_recipes { action: "run", name: "<name>" }.',
        ].join('\n')
      }
      if (action === 'heal') {
        const committed = options.repair?.commit() ?? null
        const id = String(args.id ?? committed?.recipeId ?? '').trim()
        if (id === '') {
          return 'nothing to remember: no saved flow stopped recently, so there is no repair to store.'
        }
        if (committed?.autoApplied === true) {
          options.sessions.record({
            sessionId: sessionIdOf(exec),
            tool: 'browser_demo_recipe',
            summary: `Auto-adapted saved flow "${committed.recipeName}"`,
            outcome: 'ok',
          })
          return [
            `saved flow: ${committed.recipeName} — repair applied automatically (自动适应 is on)`,
            ...committed.lines.map(line => `- ${line}`),
            'Action: tell the user the flow was updated without asking, and that 撤销上次修改 in the sidebar restores the previous version.',
          ].join('\n')
        }
        // "heal" alone only offers the fix; only an explicit accept rewrites the flow.
        if (args.accept !== true) {
          const row = store.list().find(candidate => candidate.id === id)
          const proposal = row?.pendingHeal
          if (committed === null && proposal === undefined) {
            return `nothing to remember: no repair for "${row?.name ?? id}" — the flow either ran clean or the difference was not a moved control.`
          }
          options.sessions.record({
            sessionId: sessionIdOf(exec),
            tool: 'browser_demo_recipe',
            summary: `Offered a repair for saved flow "${row?.name ?? id}"`,
            outcome: 'ok',
          })
          return [
            `saved flow: ${row?.name ?? id} — repair offered`,
            ...(committed === null ? [] : committed.lines.map(line => `- ${line}`)),
            'Action: tell the user you worked around a changed control and that they can accept the fix in the sidebar (演示录制 → this flow). Do not claim the flow itself was updated.',
          ].join('\n')
        }
        const resolved = store.resolveHeal({ id, accept: true })
        if (!resolved.ok) {
          return `nothing to remember: ${resolved.error}`
        }
        options.sessions.record({
          sessionId: sessionIdOf(exec),
          tool: 'browser_demo_recipe',
          summary: `Applied a repair for saved flow "${resolved.recipe.name}"`,
          outcome: 'ok',
        })
        return [
          `saved flow: ${resolved.recipe.name} — repair applied`,
          ...(committed === null ? [] : committed.lines.map(line => `- ${line}`)),
          'Action: the flow now uses the control you found. Tell the user it should work next time, and that the previous version can be restored in the sidebar.',
        ].join('\n')
      }
      if (action !== 'run') throw new Error('action must be "list", "run" or "heal"')
      const wanted = String(args.name ?? '').trim()
      if (wanted === '') throw new Error('name is required for action=run')
      const exact = rows.find(row => row.name.toLowerCase() === wanted.toLowerCase())
      const partial = rows.filter(row => row.name.toLowerCase().includes(wanted.toLowerCase()))
      const meta = exact ?? (partial.length === 1 ? partial[0] : undefined)
      if (meta === undefined) {
        throw new Error(rows.length === 0
          ? 'No saved flows yet; the user can save one from the sidebar demonstration panel.'
          : `No unique saved flow matching "${wanted}"; saved: ${rows.map(row => row.name).join(', ')}`)
      }
      const recipe = store.get(meta.id)
      if (recipe === undefined) throw new Error('The saved flow disappeared; list again.')
      const wantedSite = String(args.site ?? '').trim()
      if (wantedSite !== '' && meta.site !== undefined && meta.site !== wantedSite) {
        throw new Error(`site ${JSON.stringify(wantedSite)} does not match flow "${meta.name}" (${meta.site}). Pass the site exactly as action=list shows it.`)
      }
      // A new run closes whatever the last one left waiting for a decision.
      options.repair?.commit()
      const provided = args.vars !== null && typeof args.vars === 'object'
        ? Object.fromEntries(Object.entries(args.vars as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => [key, String(value)]))
        : {}
      const prepared = prepareRecipeValues(recipe, provided)
      if (prepared.missing.length > 0) {
        // Ask in the user's words, not in variable ids: the model repeats this
        // back to the user, so it has to read like a question.
        const wanted = prepared.missing.map(variable => variable.label).join('、')
        const example = JSON.stringify(Object.fromEntries(prepared.missing.map(variable => [variable.label, '…'])))
        throw new Error(
          `Flow "${recipe.name}" still needs ${wanted}. Ask the user for ${prepared.missing.length === 1 ? 'it' : 'them'} in one short question, `
          + `then run again with vars: ${example}. Dates may be relative: 今天 / 上周 / 本月 / 上季度 / 2026-11-01.`,
        )
      }
      const replaySteps = applyRecipeVars(recipe.steps, prepared.values)
      const resolvedNote = prepared.resolved.length === 0
        ? []
        : [`resolved: ${prepared.resolved.map(item => `${item.label} ${item.from} → ${item.to}`).join('; ')}`]
      const sessionId = sessionIdOf(exec)
      await ensureConnected()
      await ensureSessionTab(sessionId)
      const firstUrl = recipe.steps.find(step => step.tabUrl !== undefined)?.tabUrl
      await requireMutation(
        exec,
        'browser_demo_recipes',
        `运行已保存流程「${recipe.name}」（${recipe.steps.length} 步）`,
        firstUrl,
      )
      const outcome = await replayDemoSteps(driverOf(options), replaySteps)
      const ranAll = outcome.status === 'done'
      if (!ranAll) {
        // A secret is a pause for the user, not a page change; everything else
        // is worth watching, because the agent is about to solve it by hand.
        const failedStep = recipe.steps[outcome.performed]
        const isSecret = /masked|secret field/i.test(outcome.reason)
          || (failedStep !== undefined && failedStep.kind === 'fill' && failedStep.masked)
        if (!isSecret && failedStep !== undefined && options.repair !== undefined) {
          const tabId = options.sessions.tabOf(sessionId)
          options.repair.begin({
            recipeId: recipe.id,
            recipeName: recipe.name,
            index: outcome.performed,
            step: failedStep,
            reason: outcome.reason,
            ...(tabId === undefined ? {} : { tabId }),
            ...(outcome.url === undefined ? {} : { tabUrl: outcome.url }),
          })
        }
      }
      options.sessions.record({
        sessionId,
        tool: 'browser_demo_recipes',
        summary: `Ran saved flow "${recipe.name}" (${outcome.performed}/${outcome.total}${ranAll ? '' : ', stopped'})`,
        outcome: ranAll ? 'ok' : 'error',
      })
      if (ranAll) {
        return [
          `saved flow: ${recipe.name} — replayed ${outcome.performed}/${outcome.total}`,
          ...resolvedNote,
          ...outcome.lines,
          `url: ${outcome.url}`,
          'Action: the flow ran to the end. Report what changed on screen; browser_snapshot if you need the new page.',
        ].join('\n')
      }
      const pending = outcome.pending.map((step, offset) => {
        const n = outcome.performed + offset + 1
        return `${n}. todo ${describeDemoStep(step)}`
      })
      return [
        `saved flow: ${recipe.name} — replayed ${outcome.performed}/${outcome.total}`,
        ...resolvedNote,
        ...outcome.lines,
        `stopped at step ${outcome.performed + 1}: ${outcome.reason}`,
        ...pending,
        'Action: the replay stopped; the page is whatever the last ok step left behind. Continue with browser_snapshot + click/type, or browser_ask_user for a secret. Do not claim the flow finished. If a control had moved and you worked around it, finish the job and then call browser_demo_recipes { action: "heal" } so the user can keep that fix.',
      ].join('\n')
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
