import type { Context } from '@deepseek-ai/cordis'
import type { BrowserAgentBrowser, BrowserAgentIdleClose } from '../../config.ts'
import { browserAgentIdleCloseMs } from '../../config.ts'
import type { SoftPauseGate } from '../soft-pause/gate.ts'
import { BrowserApprovalGate } from './approval.ts'
import type { BrowserDriver, BrowserDriverStatus } from './driver.ts'
import { BrowserHumanGate } from './human-gate.ts'
import {
  BROWSER_AGENT_PROFILE_SLOTS,
  browserAgentProfileDirFor,
  browserAgentProfileSlotDir,
  playwrightChannelSatisfiesPreference,
  resolveBrowserExecutable,
  stopAgentBrowserProcesses,
  type PlaywrightChannel,
} from './launch.ts'
import { PlaywrightDriver } from './playwright-driver.ts'
import type { TabListBody } from './protocol.ts'
import { registerBrowserAgentPrompt } from './prompt.ts'
import { BrowserSessionState } from './session-state.ts'
import { TabScopeStore } from './tab-scope.ts'
import { diagnose, type BrowserAvailability, type Diagnosis } from './diagnose.ts'
import {
  demoTabLegend,
  describeDemoStep,
  describeDemoStepHuman,
  summarizeDemoSteps,
  type DemoStep,
} from './demo.ts'
import { suggestRecipeVariables } from './demo-values.ts'
import { replayDemoSteps } from './demo-replay.ts'
import { applyRecipeVars, prepareRecipeValues, type DemoRecipeMeta, type DemoRecipeStore } from './demo-recipes.ts'
import { browserPermission, registerBrowserTools, type BrowserPermissionMode } from './tools.ts'
import { DemoRepairTracker, createRepairHooks } from './demo-heal.ts'

/** Idle sweep cadence; the tab age comes from browserAgentIdleClose. */
const IDLE_TICK_MS = 60_000

export interface BrowserAgentRuntime {
  readonly approval: BrowserApprovalGate
  readonly human: BrowserHumanGate
  readonly sessions: BrowserSessionState
  driverStatus(): BrowserDriverStatus | null
  /** What is wrong (if anything) and the concrete next step. */
  diagnose(): Diagnosis
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
   * Sidebar toggle: mark a tab read-only so mutating tools fail fast there.
   * Reading tools (snapshot / extract / scroll / wait) keep working.
   */
  setTabReadOnly(input: {
    readonly tabId: number
    readonly readOnly: boolean
  }): { readonly ok: boolean; readonly error?: string }
  /** Sidebar demonstration recorder: watch the user, then hand back the steps. */
  demoStart(): Promise<{ readonly ok: boolean; readonly error?: string }>
  demoStop(): Promise<{ readonly ok: boolean; readonly steps?: readonly string[]; readonly error?: string }>
  demoActive(): boolean
  /** Steps from the last completed recording (agent- or sidebar-started). */
  lastDemonstrationSteps(): number
  /**
   * Saved demonstrations (cross-session): list, save the last recording, run one
   * back, or delete it. Steps are stored sanitized; secrets stay `***`.
   */
  demoRecipes(input: {
    readonly action: 'list' | 'save' | 'run' | 'delete' | 'steps' | 'rename' | 'parameterize' | 'variable' | 'unvariable' | 'unattended' | 'heal' | 'rollback'
    readonly name?: string
    readonly id?: string
    readonly index?: number
    readonly accept?: boolean
    readonly label?: string
    readonly default?: string
    readonly ask?: boolean
    readonly unattended?: boolean
    readonly vars?: Readonly<Record<string, string>>
  }): Promise<{
    readonly ok: boolean
    readonly recipes?: readonly DemoRecipeMeta[]
    readonly recipe?: DemoRecipeMeta
    readonly lines?: readonly string[]
    readonly healed?: boolean
    /** Values worth turning into variables (action=save). */
    readonly suggestions?: readonly {
      readonly index: number
      readonly label: string
      readonly value: string
    }[]
    readonly steps?: readonly {
      readonly index: number
      readonly kind: 'navigate' | 'click' | 'fill' | 'press'
      readonly label: string
      readonly canParameterize: boolean
    }[]
    readonly stoppedAt?: number
    readonly reason?: string
    readonly error?: string
  }>
  /** Bumped when a saved flow changes; the sidebar re-reads the list on change. */
  recipesRevision(): number
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
    /** Debug tools switch: gates browser_network / browser_console / browser_emulate. */
    readonly debugTools?: () => boolean
    /** Demonstration recorder switch: gates browser_demonstrate. */
    readonly demonstrate?: () => boolean
    /** Keep a repair by itself (locator only, same site). Off unless the user says so. */
    readonly autoHeal?: () => boolean
    /** Close agent tabs nobody used for a while (never bound / active / last tab). */
    readonly idleClose?: () => BrowserAgentIdleClose
    /** Saved demonstrations; omitted in tests that do not care. */
    readonly recipes?: DemoRecipeStore
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
  const tabScope = new TabScopeStore()
  const recipes = options.recipes
  /** Steps from the last sidebar demonstration, until the next one starts. */
  let lastDemoSteps: readonly DemoStep[] = []
  /**
   * What the official Permissions selector says for a session. The service is
   * optional (older Desktop builds have no presets); when it is missing we keep
   * the local approval card as before.
   */
  let warnedNoPermissionService = false
  const permissionMode = (session: unknown): BrowserPermissionMode | undefined => {
    const get = (ctx as unknown as { get?: (name: string) => unknown }).get?.bind(ctx)
    let preset: unknown
    let approval: unknown
    try {
      const presets = get?.('permissionPresets') as { current?: (session: unknown) => unknown } | undefined
      if (presets !== undefined && typeof presets.current === 'function') preset = presets.current(session)
      // Same service auto-review reads: the policy every ask resolves under.
      const gate = get?.('approval') as { effectivePolicy?: (session: unknown) => unknown } | undefined
      if (gate !== undefined && typeof gate.effectivePolicy === 'function') approval = gate.effectivePolicy(session)
    } catch {
      return undefined
    }
    if (preset === undefined && approval === undefined) {
      // Older host: keep the local card, but say so once — otherwise "full
      // access still asks" looks like a bug in the preset.
      if (!warnedNoPermissionService) {
        warnedNoPermissionService = true
        ctx.logger.warn(
          'agent-enhancer: permission preset/approval services not found; browser approvals keep their own card',
        )
      }
      return undefined
    }
    return browserPermission({ preset, approval })
  }

  /** Watches a stopped flow so the agent's own fix can become a proposal. */
  const repairTracker = new DemoRepairTracker()
  const repairHooks = createRepairHooks({
    tracker: repairTracker,
    ...(recipes === undefined ? {} : { store: recipes }),
    ...(options.autoHeal === undefined ? {} : { autoApply: options.autoHeal }),
  })

  /**
   * Browser probe, cached until settings change. resolveBrowserExecutable spawns
   * `where`/`which` when a browser is not in the usual places, and the sidebar
   * polls the snapshot every ~800 ms, so this must not run per snapshot.
   */
  let availabilityCache: BrowserAvailability | null = null
  const browserAvailability = (): BrowserAvailability => {
    if (availabilityCache !== null) return availabilityCache
    availabilityCache = {
      chrome: resolveBrowserExecutable('chrome') !== null,
      edge: resolveBrowserExecutable('edge') !== null,
      safari: resolveBrowserExecutable('safari') !== null,
    }
    return availabilityCache
  }

  const diagnoseNow = (): Diagnosis => {
    const status = activeDriver?.status()
    return diagnose({
      enabled: options.enabled(),
      ready: status?.ready === true,
      preference: options.browserPreference(),
      platform: process.platform,
      lastError: status?.lastError ?? null,
      availability: browserAvailability(),
    })
  }
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
    // Tab ids belong to the driver instance; its tabs close with it.
    tabScope.clear()
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
        tabScope,
        debugTools: () => options.debugTools?.() === true,
        demonstrate: () => options.demonstrate?.() === true,
        onDemonstration: steps => { lastDemoSteps = steps },
        permission: permissionMode,
        ...(recipes === undefined ? {} : { recipes }),
        repair: repairHooks,
        diagnosis: diagnoseNow,
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
        primeCapture()
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
      primeCapture()
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

  /**
   * Capture must be running before the traffic happens, so start it as soon as
   * the debug switch is on and the driver lives. Best-effort: the tools also
   * call startCapture().
   */
  const primeCapture = () => {
    if (options.debugTools?.() !== true) return
    try {
      requireDriver().startCapture()
    } catch {
      // Driver not mounted yet; the first debug tool call will start the buffer.
    }
  }

  const mount = () => {
    const preference = options.browserPreference()
    createDriver(preference)
    ensureToolsRegistered()
  }

  const refresh = () => {
    // Settings changed (feature switch, browser choice): re-probe on next snapshot.
    availabilityCache = null
    // Switching debug tools off must stop buffering, not just hide the tools.
    // `?.` on the call keeps a driver instance from a previous hot-reloaded
    // build (no stopCapture yet) from breaking a settings update.
    if (options.debugTools?.() !== true) activeDriver?.stopCapture?.()
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

  const sweepIdleTabs = async (): Promise<void> => {
    if (!options.enabled()) return
    const idleMs = browserAgentIdleCloseMs(options.idleClose?.() ?? '10m')
    if (idleMs === null) return
    const driver = activeDriver
    if (driver === null || driver.status().ready !== true) return
    try {
      const closed = await driver.sweepIdleTabs({
        idleMs,
        keep: sessions.boundTabIds(),
      })
      for (const tabId of closed) {
        const sessionId = sessions.unbindTab(tabId)
        tabScope.setReadOnly(tabId, false)
        sessions.record({
          sessionId: sessionId ?? 'host',
          tool: 'browser_idle_close',
          summary: `Closed idle tab ${tabId}`,
          outcome: 'ok',
        })
      }
    } catch (error) {
      ctx.logger.warn(
        `agent-enhancer: idle tab sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // One minute tick: cheap when nothing is idle, and unref'd so a plugin reload
  // never keeps the Desktop process alive.
  const idleTimer = setInterval(() => { void sweepIdleTabs() }, IDLE_TICK_MS)
  idleTimer.unref?.()

  return {
    approval,
    human,
    sessions,
    driverStatus() {
      return activeDriver?.status() ?? null
    },
    diagnose() {
      return diagnoseNow()
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
        // Retire scopes of tabs that are gone (ids are never reused, so this is
        // only growth control, not a correctness requirement).
        tabScope.retain(body.tabs.map(tab => tab.tabId))
        sessions.retainTabs(body.tabs.map(tab => tab.tabId))
        return {
          tabs: body.tabs.map(tab => ({
            ...tab,
            bound: sessions.sessionOf(tab.tabId) !== undefined,
            readOnly: tabScope.isReadOnly(tab.tabId),
          })),
          boundTabId: body.boundTabId,
        }
      } catch {
        return { tabs: [], boundTabId: null }
      }
    },
    setTabReadOnly(input) {
      if (!options.enabled()) return { ok: false, error: 'Browser agent disabled' }
      tabScope.setReadOnly(input.tabId, input.readOnly)
      sessions.record({
        sessionId: 'sidebar',
        tool: 'browser_tab_read_only',
        summary: `${input.readOnly ? 'Read-only' : 'Writable'} tab ${input.tabId}`,
        outcome: 'ok',
      })
      return { ok: true }
    },
    async demoStart() {
      if (!options.enabled()) return { ok: false, error: 'Browser agent disabled' }
      if (options.demonstrate?.() !== true) {
        return { ok: false, error: '演示录制未开启：设置 → 功能 → 浏览器 Agent' }
      }
      try {
        const aligned = await alignToPreference()
        if (!aligned.ok) return { ok: false, error: aligned.error ?? 'Browser agent failed to start' }
        await requireDriver().startDemonstration()
        lastDemoSteps = []
        sessions.record({
          sessionId: 'sidebar',
          tool: 'browser_demonstrate',
          summary: 'Demonstration recording started from the sidebar',
          outcome: 'needs_human',
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    async demoStop() {
      const driver = activeDriver
      if (driver === null) return { ok: false, error: 'Browser agent is not running' }
      try {
        const steps = await driver.stopDemonstration()
        lastDemoSteps = steps
        const summary = summarizeDemoSteps(steps)
        sessions.record({
          sessionId: 'sidebar',
          tool: 'browser_demonstrate',
          summary: `Demonstration stopped from the sidebar (${summary.shown} step(s)${summary.multiTab ? ` across ${summary.tabs.length} tabs` : ''})`,
          outcome: 'ok',
        })
        return { ok: true, steps: [...demoTabLegend(summary), ...summary.lines] }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    demoActive() {
      return activeDriver?.demonstrationActive() === true
    },
    lastDemonstrationSteps() {
      return lastDemoSteps.length
    },
    recipesRevision() {
      return recipes?.revision() ?? 0
    },
    async demoRecipes(input) {
      if (!options.enabled()) return { ok: false, error: 'Browser agent disabled' }
      if (recipes === undefined) return { ok: false, error: 'recipe store unavailable' }
      // A repair the agent finished but never reported becomes a proposal here,
      // so opening the panel cannot lose it.
      repairHooks.commit()
      if (input.action === 'list') {
        return { ok: true, recipes: recipes.list() }
      }
      if (input.action === 'save') {
        if (options.demonstrate?.() !== true) {
          return { ok: false, error: '演示录制未开启：设置 → 功能 → 浏览器 Agent' }
        }
        if (lastDemoSteps.length === 0) {
          return { ok: false, error: '先录制一次，再保存为流程', recipes: recipes.list() }
        }
        const saved = recipes.save({ name: input.name ?? '', steps: lastDemoSteps })
        if (!saved.ok) return { ok: false, error: saved.error, recipes: recipes.list() }
        sessions.record({
          sessionId: 'sidebar',
          tool: 'browser_demo_recipe',
          summary: `Saved demonstration recipe "${saved.recipe.name}" (${saved.recipe.steps} step(s))`,
          outcome: 'ok',
        })
        return {
          ok: true,
          recipe: saved.recipe,
          recipes: recipes.list(),
          // Offered, never applied: the user decides what becomes a variable.
          suggestions: suggestRecipeVariables(lastDemoSteps),
        }
      }
      if (input.action === 'delete') {
        const id = input.id ?? ''
        const removed = recipes.remove(id)
        sessions.record({
          sessionId: 'sidebar',
          tool: 'browser_demo_recipe',
          summary: removed ? `Deleted demonstration recipe ${id}` : `Recipe ${id} not found`,
          outcome: removed ? 'ok' : 'error',
        })
        return removed ? { ok: true, recipes: recipes.list() } : { ok: false, error: '流程不存在', recipes: recipes.list() }
      }
      if (input.action === 'steps') {
        const recipe = recipes.get(input.id ?? '')
        if (recipe === undefined) return { ok: false, error: '流程不存在', recipes: recipes.list() }
        return {
          ok: true,
          recipes: recipes.list(),
          lines: recipe.steps.map((step, index) => `${index + 1}. ${describeDemoStep(step)}`),
          steps: recipe.steps.map((step, index) => ({
            index,
            kind: step.kind,
            label: describeDemoStepHuman(step, recipe.variables),
            canParameterize: step.kind === 'fill'
              && !step.masked
              && !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(step.value),
          })),
        }
      }
      if (input.action === 'parameterize') {
        const result = recipes.parameterize({
          id: input.id ?? '',
          index: input.index ?? -1,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.label === undefined ? {} : { label: input.label }),
        })
        if (!result.ok) return { ok: false, error: result.error, recipes: recipes.list() }
        sessions.record({
          sessionId: 'sidebar',
          tool: 'browser_demo_recipe',
          summary: `Parameterized demonstration recipe "${result.recipe.name}"`,
          outcome: 'ok',
        })
        return { ok: true, recipe: result.recipe, recipes: recipes.list() }
      }
      if (input.action === 'rename') {
        const renamed = recipes.rename({ id: input.id ?? '', name: input.name ?? '' })
        if (!renamed.ok) return { ok: false, error: renamed.error, recipes: recipes.list() }
        sessions.record({
          sessionId: 'sidebar',
          tool: 'browser_demo_recipe',
          summary: `Renamed demonstration recipe to "${renamed.recipe.name}"`,
          outcome: 'ok',
        })
        return { ok: true, recipe: renamed.recipe, recipes: recipes.list() }
      }
      if (input.action === 'variable') {
        const updated = recipes.updateVariable({
          id: input.id ?? '',
          name: input.name ?? '',
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.default === undefined ? {} : { default: input.default }),
          ...(input.ask === undefined ? {} : { ask: input.ask }),
        })
        if (!updated.ok) return { ok: false, error: updated.error, recipes: recipes.list() }
        sessions.record({
          sessionId: 'sidebar',
          tool: 'browser_demo_recipe',
          summary: 'Updated a flow variable on "' + updated.recipe.name + '"',
          outcome: 'ok',
        })
        return { ok: true, recipe: updated.recipe, recipes: recipes.list() }
      }
      if (input.action === 'unattended') {
        const updated = recipes.setUnattended({
          id: input.id ?? '',
          unattended: input.unattended === true,
        })
        if (!updated.ok) return { ok: false, error: updated.error, recipes: recipes.list() }
        sessions.record({
          sessionId: 'sidebar',
          tool: 'browser_demo_recipe',
          summary: (updated.recipe.unattended ? 'Allowed' : 'Stopped') + ' unattended runs for "' + updated.recipe.name + '"',
          outcome: 'ok',
        })
        return { ok: true, recipe: updated.recipe, recipes: recipes.list() }
      }
      if (input.action === 'unvariable') {
        const reverted = recipes.removeVariable({ id: input.id ?? '', name: input.name ?? '' })
        if (!reverted.ok) return { ok: false, error: reverted.error, recipes: recipes.list() }
        sessions.record({
          sessionId: 'sidebar',
          tool: 'browser_demo_recipe',
          summary: 'Restored a fixed value in "' + reverted.recipe.name + '"',
          outcome: 'ok',
        })
        return { ok: true, recipe: reverted.recipe, recipes: recipes.list() }
      }
      if (input.action === 'heal') {
        const resolved = recipes.resolveHeal({ id: input.id ?? '', accept: input.accept === true })
        if (!resolved.ok) return { ok: false, error: resolved.error, recipes: recipes.list() }
        sessions.record({
          sessionId: 'sidebar',
          tool: 'browser_demo_recipe',
          summary: `${input.accept === true ? 'Applied' : 'Dismissed'} a repair for "${resolved.recipe.name}"`,
          outcome: 'ok',
        })
        return {
          ok: true,
          healed: input.accept === true,
          recipe: resolved.recipe,
          recipes: recipes.list(),
        }
      }
      if (input.action === 'rollback') {
        const restored = recipes.rollback({ id: input.id ?? '' })
        if (!restored.ok) return { ok: false, error: restored.error, recipes: recipes.list() }
        sessions.record({
          sessionId: 'sidebar',
          tool: 'browser_demo_recipe',
          summary: `Restored the previous version of "${restored.recipe.name}"`,
          outcome: 'ok',
        })
        return { ok: true, recipe: restored.recipe, recipes: recipes.list() }
      }
      // run
      const recipe = recipes.get(input.id ?? '')
      if (recipe === undefined) return { ok: false, error: '流程不存在', recipes: recipes.list() }
      // A new run closes whatever the last one left waiting for a decision.
      repairHooks.commit()
      const prepared = prepareRecipeValues(recipe, input.vars ?? {})
      if (prepared.missing.length > 0) {
        return {
          ok: false,
          error: `还缺少：${prepared.missing.map(variable => variable.label).join('、')}`,
          recipes: recipes.list(),
        }
      }
      const steps = applyRecipeVars(recipe.steps, prepared.values)
      const driver = activeDriver
      if (driver === null) return { ok: false, error: 'Browser agent is not running', recipes: recipes.list() }
      const aligned = await alignToPreference().catch(() => ({ ok: true as const, error: undefined }))
      if (!aligned.ok) return { ok: false, error: aligned.error ?? 'Browser agent failed to start', recipes: recipes.list() }
      const outcome = await replayDemoSteps(driver, steps).catch(error => ({
        status: 'blocked' as const,
        performed: 0,
        total: steps.length,
        lines: [] as string[],
        reason: error instanceof Error ? error.message : String(error),
        pending: [...steps],
      }))
      const ranAll = outcome.status === 'done'
      if (!ranAll) {
        const failedStep = recipe.steps[outcome.performed]
        const isSecret = /masked|secret field/i.test(outcome.reason)
          || (failedStep !== undefined && failedStep.kind === 'fill' && failedStep.masked)
        if (!isSecret && failedStep !== undefined) {
          const stopUrl = 'url' in outcome ? outcome.url : undefined
          repairTracker.begin({
            recipeId: recipe.id,
            recipeName: recipe.name,
            index: outcome.performed,
            step: failedStep,
            reason: outcome.reason,
            ...(stopUrl === undefined ? {} : { tabUrl: stopUrl }),
          })
        }
      }
      sessions.record({
        sessionId: 'sidebar',
        tool: 'browser_demo_recipe',
        summary: `Ran demonstration recipe "${recipe.name}" (${outcome.performed}/${outcome.total}${ranAll ? '' : ', stopped'})`,
        outcome: ranAll ? 'ok' : 'error',
      })
      return {
        ok: true,
        recipes: recipes.list(),
        lines: [
          ...(prepared.resolved.length === 0
            ? []
            : [`resolved: ${prepared.resolved.map(item => `${item.label} ${item.from} → ${item.to}`).join('; ')}`]),
          ...outcome.lines,
        ],
        ...(ranAll ? {} : { stoppedAt: outcome.performed + 1 }),
        ...(ranAll ? {} : { reason: outcome.reason }),
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
      clearInterval(idleTimer)
      approval.clearAll()
      human.clearAll()
      await switchGate.catch(() => undefined)
      await tearDownActiveAsync()
    },
  }
}
