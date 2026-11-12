import type { Context } from '@deepseek-ai/cordis'
import type { BrowserAgentBrowser } from '../../config.ts'
import type { SoftPauseGate } from '../soft-pause/gate.ts'
import { BrowserApprovalGate } from './approval.ts'
import type { BrowserDriver, BrowserDriverStatus } from './driver.ts'
import { BrowserHumanGate } from './human-gate.ts'
import {
  BROWSER_AGENT_PROFILE_SLOTS,
  browserAgentProfileDirFor,
  browserAgentProfileSlotDir,
  playwrightChannelSatisfiesPreference,
  stopAgentBrowserProcesses,
  type PlaywrightChannel,
} from './launch.ts'
import { PlaywrightDriver } from './playwright-driver.ts'
import type { TabListBody } from './protocol.ts'
import { registerBrowserAgentPrompt } from './prompt.ts'
import { BrowserSessionState } from './session-state.ts'
import { registerBrowserTools } from './tools.ts'

export interface BrowserAgentRuntime {
  readonly approval: BrowserApprovalGate
  readonly human: BrowserHumanGate
  readonly sessions: BrowserSessionState
  driverStatus(): BrowserDriverStatus | null
  activeProfileDir(): string
  /**
   * Kill any running agent browser and launch with an explicit preference.
   * Preference override (from the Launch button) always wins over cached settings.
   */
  launchDedicated(
    startUrl?: string,
    preference?: BrowserAgentBrowser,
  ): Promise<{ readonly ok: boolean; readonly error?: string }>
  /**
   * Ensure the running browser matches the current preference.
   * Used by Agent dialog tools (`browser_navigate`, etc.) — not only the Launch button.
   */
  alignToPreference(startUrl?: string): Promise<{ readonly ok: boolean; readonly error?: string }>
  refresh(): void
  /** Open tabs in the dedicated browser (no auto-launch). */
  listTabs(): Promise<TabListBody>
  /**
   * Focus a tab for Agent ops; optionally bind it to a chat session.
   * Used by the right-sidebar multi-tab picker.
   */
  selectTab(input: {
    readonly tabId: number
    readonly sessionId?: string
  }): Promise<{
    readonly ok: boolean
    readonly tabId?: number
    readonly url?: string
    readonly title?: string
    readonly error?: string
  }>
  resolveTabConflict(decision: 'follow' | 'stay'): Promise<{
    readonly ok: boolean
    readonly tabId?: number
    readonly url?: string
    readonly title?: string
  }>
  openUrl(input: {
    readonly sessionId: string
    readonly url: string
  }): Promise<{ readonly ok: boolean; readonly url?: string; readonly title?: string; readonly error?: string }>
  quotePage(sessionId: string): Promise<{
    readonly ok: boolean
    readonly text?: string
    readonly url?: string
    readonly title?: string
    readonly error?: string
  }>
  acknowledgeHuman(sessionId?: string): boolean
  dispose(): Promise<void>
}

/**
 * Mount Playwright browser tools when the feature is enabled.
 */
export function installBrowserAgent(
  ctx: Context,
  options: {
    readonly enabled: () => boolean
    readonly browserPreference: () => BrowserAgentBrowser
    readonly profileRoot: string
    readonly softPause: SoftPauseGate
    readonly softPauseEnabled: () => boolean
    readonly onBrowserMutation?: (info: {
      readonly sessionId: string
      readonly tool: string
      readonly url?: string
    }) => void
  },
): BrowserAgentRuntime {
  const approval = new BrowserApprovalGate()
  const human = new BrowserHumanGate()
  const sessions = new BrowserSessionState()
  let unregisterTools: (() => void) | null = null
  let unregisterPrompt: (() => void) | null = null
  let active = false
  let mountedPreference: BrowserAgentBrowser | null = null
  let activeDriver: BrowserDriver | null = null
  let playwrightDriver: PlaywrightDriver | null = null
  /** Serializes preference remounts so Chrome dispose finishes before Edge launch. */
  let switchGate: Promise<void> = Promise.resolve()
  let switchEpoch = 0
  let switchPending = false

  const currentProfileDir = () => browserAgentProfileDirFor(
    options.profileRoot,
    options.browserPreference(),
  )

  const stopAllProfileSlots = () => {
    for (const slot of BROWSER_AGENT_PROFILE_SLOTS) {
      stopAgentBrowserProcesses(browserAgentProfileSlotDir(options.profileRoot, slot))
    }
  }

  const enqueueSwitch = (work: () => Promise<void>) => {
    switchPending = true
    const epoch = ++switchEpoch
    switchGate = switchGate
      .then(work)
      .catch(error => {
        const detail = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`agent-enhancer: browser driver remount failed: ${detail}`)
      })
      .finally(() => {
        if (epoch !== switchEpoch) return
        switchPending = false
        // Live reload / rapid toggle: async teardown can finish after a later
        // refresh(enabled) early-returned on switchPending. Remount if still on.
        if (options.enabled() && unregisterTools === null) {
          active = true
          mount()
        }
      })
  }

  /** Dispose Playwright only — keep tools registered (they resolve driver via getter). */
  const tearDownDriverAsync = async () => {
    const previousPreference = mountedPreference
    activeDriver = null
    mountedPreference = null
    const pw = playwrightDriver
    playwrightDriver = null
    if (pw !== null) {
      await pw.dispose().catch(() => undefined)
    }
    if (previousPreference !== null) {
      stopAgentBrowserProcesses(browserAgentProfileDirFor(options.profileRoot, previousPreference))
    }
  }

  const tearDownActiveAsync = async () => {
    unregisterTools?.()
    unregisterTools = null
    unregisterPrompt?.()
    unregisterPrompt = null
    await tearDownDriverAsync()
  }

  const requireDriver = (): BrowserDriver => {
    if (activeDriver === null) {
      throw new Error('Browser agent driver is not mounted')
    }
    return activeDriver
  }

  const preferenceMatchesRunning = (preference: BrowserAgentBrowser): boolean => {
    if (activeDriver === null || mountedPreference !== preference) return false
    const status = activeDriver.status()
    // Cold driver for this preference — ensureReady can launch in place.
    if (!status.ready) return true
    // Accept any channel allowed by the preference (auto may keep Chrome after
    // a WebKit miss — do not tear down every Agent tool tick).
    const endpoint = status.endpoint ?? ''
    if (!endpoint.startsWith('playwright:')) return false
    const channel = endpoint.slice('playwright:'.length) as PlaywrightChannel
    return playwrightChannelSatisfiesPreference(channel, preference, process.platform)
  }

  const createDriver = (_preference: BrowserAgentBrowser) => {
    // Always live getters: Agent tools and Settings changes must not freeze the
    // first Launch preference into a static string (that made dialog opens sticky).
    mountedPreference = options.browserPreference()
    playwrightDriver = new PlaywrightDriver({
      profileDir: () => browserAgentProfileDirFor(options.profileRoot, options.browserPreference()),
      preference: () => options.browserPreference(),
      profileRoot: options.profileRoot,
      headless: false,
    })
    activeDriver = playwrightDriver
  }

  const ensureToolsRegistered = () => {
    if (unregisterPrompt === null) {
      unregisterPrompt = registerBrowserAgentPrompt(ctx)
    }
    if (unregisterTools === null) {
      unregisterTools = registerBrowserTools(ctx, {
        driver: requireDriver,
        alignPreference: async startUrl => {
          const result = await alignToPreference(startUrl)
          if (!result.ok) {
            throw new Error(result.error ?? 'Browser agent failed to align preference')
          }
        },
        approval,
        human,
        sessions,
        // Gate on settings only — `active` flips false during driver align and
        // must not make browser_* look "disabled" mid-turn.
        enabled: () => options.enabled(),
        onMutation: options.onBrowserMutation,
      })
    }
  }

  /**
   * Hard-align running browser to preference. Shared by Launch button and
   * Agent dialog tools (browser_navigate / ensureConnected).
   */
  const alignToPreference = async (
    startUrl?: string,
    preferenceOverride?: BrowserAgentBrowser,
  ): Promise<{ readonly ok: boolean; readonly error?: string }> => {
    if (!options.enabled()) return { ok: false, error: 'Browser agent disabled' }
    await switchGate.catch(() => undefined)
    const preference = preferenceOverride ?? options.browserPreference()
    try {
      if (preferenceMatchesRunning(preference)) {
        await requireDriver().ensureReady(startUrl)
        active = true
        return { ok: true }
      }
      active = false
      await tearDownDriverAsync()
      stopAllProfileSlots()
      if (!options.enabled()) {
        return { ok: false, error: 'Browser agent disabled' }
      }
      // Freeze mountedPreference to the explicit target for this align turn
      // even if Cordis live mirror lags one tick behind the Launch override.
      mountedPreference = preference
      playwrightDriver = new PlaywrightDriver({
        profileDir: browserAgentProfileDirFor(options.profileRoot, preference),
        preference,
        profileRoot: options.profileRoot,
        headless: false,
      })
      activeDriver = playwrightDriver
      ensureToolsRegistered()
      active = true
      // After a successful explicit launch, keep getters live for later Settings
      // flips by swapping to getter-based driver only when preference was not override…
      // Actually: for override we use static for THIS instance so ensureReady
      // cannot race back to stale Cordis. Next align without override rebuilds
      // from live. For Agent path (no override), rebuild from live each mismatch.
      await activeDriver.ensureReady(startUrl)
      // Re-point mountedPreference to live after launch so activeProfileDir stays honest.
      mountedPreference = preference
      return { ok: true }
    } catch (error) {
      activeDriver = null
      playwrightDriver = null
      mountedPreference = null
      active = false
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const mount = () => {
    const preference = options.browserPreference()
    createDriver(preference)
    ensureToolsRegistered()
  }

  const refresh = () => {
    const want = options.enabled()

    if (!want) {
      if (!active && playwrightDriver === null && unregisterTools === null && !switchPending) {
        return
      }
      active = false
      approval.clearAll()
      human.clearAll()
      enqueueSwitch(() => tearDownActiveAsync())
      return
    }

    // Enabled: always heal tool registration. Preference / headed browser
    // changes stay on Launch + alignToPreference — not here.
    // Do not early-return on switchPending alone (that left Agent with zero
    // browser_* tools after live pack reload / disable→enable races).
    if (switchPending) {
      active = true
      return
    }
    if (playwrightDriver === null) {
      mount()
    } else {
      ensureToolsRegistered()
    }
    active = true
  }

  refresh()

  return {
    approval,
    human,
    sessions,
    driverStatus() {
      return activeDriver?.status() ?? null
    },
    activeProfileDir() {
      if (mountedPreference !== null) {
        return browserAgentProfileDirFor(options.profileRoot, mountedPreference)
      }
      return currentProfileDir()
    },
    async launchDedicated(startUrl, preferenceOverride) {
      return alignToPreference(startUrl, preferenceOverride)
    },
    alignToPreference(startUrl) {
      return alignToPreference(startUrl)
    },
    refresh,
    async listTabs() {
      if (!options.enabled() || activeDriver === null || activeDriver.status().ready !== true) {
        return { tabs: [], boundTabId: null }
      }
      try {
        const body = await activeDriver.listTabs()
        return {
          tabs: body.tabs.map(tab => ({
            ...tab,
            bound: sessions.sessionOf(tab.tabId) !== undefined,
          })),
          boundTabId: body.boundTabId,
        }
      } catch {
        return { tabs: [], boundTabId: null }
      }
    },
    async selectTab(input) {
      if (!options.enabled()) return { ok: false, error: 'Browser agent disabled' }
      await switchGate.catch(() => undefined)
      try {
        const aligned = await alignToPreference()
        if (!aligned.ok) return { ok: false, error: aligned.error }
        const followed = await requireDriver().followTab(input.tabId, true)
        const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim() !== ''
          ? input.sessionId.trim()
          : undefined
        if (sessionId !== undefined) {
          sessions.bind(sessionId, followed.tabId)
          sessions.rememberHttpUrl(sessionId, followed.url)
        }
        sessions.record({
          sessionId: sessionId ?? 'sidebar',
          tool: 'browser_select_tab',
          summary: `Select tab ${followed.tabId}`,
          url: followed.url,
          outcome: 'ok',
        })
        options.onBrowserMutation?.({
          sessionId: sessionId ?? 'sidebar',
          tool: 'browser_select_tab',
          url: followed.url,
        })
        return {
          ok: true,
          tabId: followed.tabId,
          url: followed.url,
          title: followed.title,
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    async resolveTabConflict(decision) {
      const conflict = sessions.currentConflict()
      if (conflict === null || activeDriver === null) return { ok: false }
      try {
        const followed = await activeDriver.followTab(
          decision === 'follow' ? conflict.activeTabId : conflict.boundTabId,
          true,
        )
        sessions.bind(conflict.sessionId, followed.tabId)
        sessions.clearConflict(conflict.sessionId)
        if (options.softPauseEnabled()) options.softPause.release(conflict.sessionId)
        return {
          ok: true,
          tabId: followed.tabId,
          url: followed.url,
          title: followed.title,
        }
      } catch {
        return { ok: false }
      }
    },
    async openUrl(input) {
      if (!options.enabled()) return { ok: false, error: 'Browser agent disabled' }
      await switchGate.catch(() => undefined)
      try {
        const ready = activeDriver?.status().ready === true
        const decision = await approval.requestApproval({
          sessionId: input.sessionId,
          tool: 'browser_open_url',
          summary: `Open ${input.url}`,
          url: input.url,
          signal: new AbortController().signal,
          forcePrompt: !ready,
        })
        if (decision === 'deny') return { ok: false, error: 'User denied' }

        const aligned = await alignToPreference(input.url)
        if (!aligned.ok) return { ok: false, error: aligned.error }
        const driver = requireDriver()
        await driver.ensureReady(input.url)
        const existing = sessions.tabOf(input.sessionId)
        if (existing !== undefined) {
          await driver.bind(existing, input.sessionId).catch(() => undefined)
        }
        const result = await driver.navigate(input.url)
        sessions.rememberHttpUrl(input.sessionId, result.url)
        const tabId = (result as { tabId?: number }).tabId
        if (typeof tabId === 'number') sessions.bind(input.sessionId, tabId)
        sessions.record({
          sessionId: input.sessionId,
          tool: 'browser_open_url',
          summary: `Open ${input.url}`,
          url: result.url,
          outcome: 'ok',
        })
        options.onBrowserMutation?.({
          sessionId: input.sessionId,
          tool: 'browser_open_url',
          url: result.url,
        })
        return { ok: true, url: result.url, title: result.title }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    async quotePage(sessionId) {
      if (!options.enabled()) return { ok: false, error: 'Browser agent disabled' }
      await switchGate.catch(() => undefined)
      try {
        const aligned = await alignToPreference()
        if (!aligned.ok) return { ok: false, error: aligned.error }
        const driver = requireDriver()
        await driver.ensureReady()
        const existing = sessions.tabOf(sessionId)
        if (existing !== undefined) {
          await driver.bind(existing, sessionId).catch(() => undefined)
        }
        const snap = await driver.snapshot()
        sessions.rememberHttpUrl(sessionId, snap.url)
        if (typeof snap.tabId === 'number') sessions.bind(sessionId, snap.tabId)
        if (snap.needsHuman === true) {
          sessions.setNeedsHuman(sessionId, 'Login or captcha on page')
        } else {
          sessions.clearNeedsHuman(sessionId)
        }
        const text = [
          snap.title.trim() === '' ? null : snap.title.trim(),
          snap.url,
          snap.textPreview.slice(0, 1_200),
        ].filter(line => line !== null && line !== '').join('\n')
        return {
          ok: true,
          text,
          url: snap.url,
          title: snap.title,
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    acknowledgeHuman(sessionId) {
      const sid = typeof sessionId === 'string' && sessionId.trim() !== ''
        ? sessionId.trim()
        : (human.current()?.sessionId
          ?? sessions.anyNeedsHuman()?.sessionId)
      if (sid === undefined) return false
      const hadBanner = sessions.needsHuman(sid) !== undefined
      const resumed = human.acknowledge(sid)
      sessions.clearNeedsHuman(sid)
      return resumed || hadBanner
    },
    async dispose() {
      active = false
      approval.clearAll()
      human.clearAll()
      await switchGate.catch(() => undefined)
      await tearDownActiveAsync()
    },
  }
}
