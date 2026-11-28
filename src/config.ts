import { AUTO_MODEL, AUTO_PROVIDER } from './host/auto-route/sentinel.ts'
import type { AutoRouteMap } from './host/auto-route/types.ts'

export const MODULES = [
  'history', 'optimize', 'predict', 'quote', 'rollback', 'softPause', 'runAlerts', 'contextInspect', 'usage',
  'sessionDelete', 'fileEdit', 'instructionsSkills', 'mcpConnectors', 'webChatBridge', 'browserAgent', 'remoteControl',
] as const
export type ModuleName = typeof MODULES[number]

/** When run alerts are enabled: how “away” must be before notifying. */
export const RUN_ALERTS_LEVELS = ['hidden', 'unfocused', 'always'] as const
export type RunAlertsLevel = typeof RUN_ALERTS_LEVELS[number]

export function resolveRunAlertsLevel(value: string | undefined): RunAlertsLevel {
  switch (value) {
    case 'hidden':
    case 'unfocused':
    case 'always':
      return value
    default:
      return 'unfocused'
  }
}

/**
 * Which desktop browser the dedicated agent window launches.
 * Platform menus filter this list — Mac offers Safari instead of Edge.
 */
export const BROWSER_AGENT_BROWSERS = ['auto', 'chrome', 'edge', 'safari'] as const
export type BrowserAgentBrowser = typeof BROWSER_AGENT_BROWSERS[number]

/** How long an unused agent tab survives before the idle sweep closes it. */
export const BROWSER_AGENT_IDLE_CLOSE = ['10m', '30m', '60m', 'never'] as const
export type BrowserAgentIdleClose = typeof BROWSER_AGENT_IDLE_CLOSE[number]

/**
 * Old configs stored a boolean (true = 10 minutes, false = never). Keep reading
 * them so an update does not silently re-enable a sweep the user turned off.
 */
export function resolveBrowserAgentIdleClose(value: unknown): BrowserAgentIdleClose {
  if (value === false) return 'never'
  if (value === true) return '10m'
  return BROWSER_AGENT_IDLE_CLOSE.includes(value as BrowserAgentIdleClose)
    ? (value as BrowserAgentIdleClose)
    : '10m'
}

/** Sweep age in ms, or null when the sweep is off. */
export function browserAgentIdleCloseMs(value: BrowserAgentIdleClose): number | null {
  switch (value) {
    case '10m':
      return 10 * 60_000
    case '30m':
      return 30 * 60_000
    case '60m':
      return 60 * 60_000
    case 'never':
      return null
    default: {
      const _exhaustive: never = value
      return _exhaustive
    }
  }
}

/**
 * Unattended run grant: one saved flow may act on its recorded origin for this
 * long, and for this many actions, without a per-action card. Kept bounded on
 * purpose — it is a security budget, not a performance knob.
 */
export const BROWSER_AGENT_UNATTENDED = {
  minutes: { min: 5, max: 60, default: 20 },
  actions: { min: 10, max: 200, default: 30 },
} as const

function clampUnattended(value: unknown, limits: { readonly min: number, readonly max: number, readonly default: number }): number {
  if (value === undefined || value === null) return limits.default
  const raw = typeof value === 'string' ? value.trim() : value
  if (raw === '') return limits.default
  const number = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(number)) return limits.default
  return Math.min(limits.max, Math.max(limits.min, Math.round(number)))
}

export function resolveBrowserAgentUnattendedMinutes(value: unknown): number {
  return clampUnattended(value, BROWSER_AGENT_UNATTENDED.minutes)
}

export function resolveBrowserAgentUnattendedActions(value: unknown): number {
  return clampUnattended(value, BROWSER_AGENT_UNATTENDED.actions)
}

export function resolveBrowserAgentBrowser(value: string | undefined): BrowserAgentBrowser {
  switch (value) {
    case 'auto':
    case 'chrome':
    case 'edge':
    case 'safari':
      return value
    default:
      return 'auto'
  }
}

/** Browser choices shown in Settings / sidebar for the current OS. */
export function browserAgentBrowsersForPlatform(
  platform: NodeJS.Platform | string,
): readonly BrowserAgentBrowser[] {
  switch (platform) {
    case 'darwin':
      return ['auto', 'chrome', 'safari']
    case 'win32':
      return ['auto', 'chrome', 'edge']
    default:
      return ['auto', 'chrome']
  }
}

/**
 * Map a saved preference onto the current OS menu.
 * Edge↔Safari swap across Windows/Mac so old settings still make sense.
 */
export function coerceBrowserAgentBrowserForPlatform(
  value: BrowserAgentBrowser,
  platform: NodeJS.Platform | string,
): BrowserAgentBrowser {
  const allowed = browserAgentBrowsersForPlatform(platform)
  if (allowed.includes(value)) return value
  if (value === 'edge' && platform === 'darwin') return 'safari'
  if (value === 'safari' && platform === 'win32') return 'edge'
  return 'auto'
}

/** Client-side OS hint (Desktop webview). Prefer navigator; fall back to process. */
export function detectUiPlatform(): 'darwin' | 'win32' | 'linux' {
  if (typeof navigator !== 'undefined') {
    const plat = navigator.platform || ''
    const ua = navigator.userAgent || ''
    if (/Mac|iPhone|iPad|iPod/i.test(plat) || /Mac OS X/i.test(ua)) return 'darwin'
    if (/Win/i.test(plat) || /Windows/i.test(ua)) return 'win32'
  }
  if (typeof process !== 'undefined') {
    if (process.platform === 'darwin' || process.platform === 'win32') return process.platform
  }
  return 'linux'
}

/** Features with dedicated provider/model settings fields. */
export type ConfigurableAuxiliaryFeature = 'optimize' | 'predict' | 'compact'
export type AuxiliaryFeature = ConfigurableAuxiliaryFeature

/** Empty provider/model means “follow the current session model”. */
export interface AuxiliaryModelSettings {
  readonly provider: string
  readonly model: string
  /** Empty means adapter default / first advertised effort. */
  readonly reasoningEffort: string
}

export type EnhancerSettings = Readonly<Record<`${ModuleName}Enabled`, boolean>> & {
  /** Per-channel switches; the master switch gates all of them. Default on. */
  readonly remoteWeixinEnabled: boolean
  readonly remoteTelegramEnabled: boolean
  readonly remoteFeishuEnabled: boolean
  readonly runAlertsLevel: RunAlertsLevel
  /** Dedicated window: auto (Win→Edge, Mac→Safari), or force a platform browser. */
  readonly browserAgentBrowser: BrowserAgentBrowser
  /** Debug + page emulation tools for the browser agent. Default off. */
  readonly browserAgentDebugTools: boolean
  /** "Show me" recorder: watch the user demonstrate a flow. Default off. */
  readonly browserAgentDemonstrate: boolean
  /** Close agent tabs nobody used for this long; `never` disables the sweep. */
  readonly browserAgentIdleClose: BrowserAgentIdleClose
  /** Unattended-run grant length in minutes (bounded, see BROWSER_AGENT_UNATTENDED). */
  readonly browserAgentUnattendedMinutes: number
  /** Unattended-run action budget (bounded, see BROWSER_AGENT_UNATTENDED). */
  readonly browserAgentUnattendedActions: number
  readonly optimizeProvider: string
  readonly optimizeModel: string
  readonly optimizeReasoningEffort: string
  readonly predictProvider: string
  readonly predictModel: string
  readonly predictReasoningEffort: string
  readonly compactProvider: string
  readonly compactModel: string
  readonly compactReasoningEffort: string
  readonly autoClassifierEnabled: boolean
  readonly autoInstantProvider: string
  readonly autoInstantModel: string
  readonly autoInstantReasoningEffort: string
  readonly autoThinkingProvider: string
  readonly autoThinkingModel: string
  readonly autoThinkingReasoningEffort: string
  readonly autoProProvider: string
  readonly autoProModel: string
  readonly autoProReasoningEffort: string
  readonly autoClassifierProvider: string
  readonly autoClassifierModel: string
  readonly autoClassifierReasoningEffort: string
}

export const DEFAULT_AUXILIARY_MODEL: AuxiliaryModelSettings = {
  provider: '',
  model: '',
  reasoningEffort: '',
}

export const DEFAULT_SETTINGS: EnhancerSettings = {
  historyEnabled: true,
  optimizeEnabled: true,
  predictEnabled: true,
  quoteEnabled: true,
  rollbackEnabled: true,
  contextInspectEnabled: true,
  usageEnabled: true,
  sessionDeleteEnabled: true,
  fileEditEnabled: true,
  softPauseEnabled: true,
  runAlertsEnabled: true,
  runAlertsLevel: 'unfocused',
  browserAgentEnabled: false,
  browserAgentBrowser: 'auto',
  browserAgentDebugTools: false,
  browserAgentDemonstrate: false,
  browserAgentIdleClose: '10m',
  browserAgentUnattendedMinutes: BROWSER_AGENT_UNATTENDED.minutes.default,
  browserAgentUnattendedActions: BROWSER_AGENT_UNATTENDED.actions.default,
  webChatBridgeEnabled: true,
  instructionsSkillsEnabled: true,
  mcpConnectorsEnabled: true,
  remoteControlEnabled: true,
  remoteWeixinEnabled: true,
  remoteTelegramEnabled: true,
  remoteFeishuEnabled: true,
  optimizeProvider: '',
  optimizeModel: '',
  optimizeReasoningEffort: '',
  predictProvider: '',
  predictModel: '',
  predictReasoningEffort: '',
  compactProvider: '',
  compactModel: '',
  compactReasoningEffort: '',
  autoClassifierEnabled: false,
  autoInstantProvider: '',
  autoInstantModel: '',
  autoInstantReasoningEffort: '',
  autoThinkingProvider: '',
  autoThinkingModel: '',
  autoThinkingReasoningEffort: '',
  autoProProvider: '',
  autoProModel: '',
  autoProReasoningEffort: '',
  autoClassifierProvider: '',
  autoClassifierModel: '',
  autoClassifierReasoningEffort: '',
}

function text(value: string | undefined): string {
  return typeof value === 'string' ? value : ''
}

export function resolveSettings(value: Partial<EnhancerSettings> | undefined): EnhancerSettings {
  return {
    historyEnabled: value?.historyEnabled ?? true,
    optimizeEnabled: value?.optimizeEnabled ?? true,
    predictEnabled: value?.predictEnabled ?? true,
    quoteEnabled: value?.quoteEnabled ?? true,
    rollbackEnabled: value?.rollbackEnabled ?? true,
    contextInspectEnabled: value?.contextInspectEnabled ?? true,
    usageEnabled: value?.usageEnabled ?? true,
    sessionDeleteEnabled: value?.sessionDeleteEnabled ?? true,
    fileEditEnabled: value?.fileEditEnabled ?? true,
    softPauseEnabled: value?.softPauseEnabled ?? true,
    runAlertsEnabled: value?.runAlertsEnabled ?? true,
    runAlertsLevel: resolveRunAlertsLevel(value?.runAlertsLevel),
    browserAgentEnabled: value?.browserAgentEnabled ?? false,
    browserAgentBrowser: resolveBrowserAgentBrowser(value?.browserAgentBrowser),
    browserAgentDebugTools: value?.browserAgentDebugTools === true,
    browserAgentDemonstrate: value?.browserAgentDemonstrate === true,
    browserAgentIdleClose: resolveBrowserAgentIdleClose(value?.browserAgentIdleClose),
    browserAgentUnattendedMinutes: resolveBrowserAgentUnattendedMinutes(value?.browserAgentUnattendedMinutes),
    browserAgentUnattendedActions: resolveBrowserAgentUnattendedActions(value?.browserAgentUnattendedActions),
    webChatBridgeEnabled: value?.webChatBridgeEnabled ?? true,
    instructionsSkillsEnabled: value?.instructionsSkillsEnabled ?? true,
    mcpConnectorsEnabled: value?.mcpConnectorsEnabled ?? true,
    remoteControlEnabled: value?.remoteControlEnabled ?? true,
    remoteWeixinEnabled: value?.remoteWeixinEnabled ?? true,
    remoteTelegramEnabled: value?.remoteTelegramEnabled ?? true,
    remoteFeishuEnabled: value?.remoteFeishuEnabled ?? true,
    optimizeProvider: text(value?.optimizeProvider),
    optimizeModel: text(value?.optimizeModel),
    optimizeReasoningEffort: text(value?.optimizeReasoningEffort),
    predictProvider: text(value?.predictProvider),
    predictModel: text(value?.predictModel),
    predictReasoningEffort: text(value?.predictReasoningEffort),
    compactProvider: text(value?.compactProvider),
    compactModel: text(value?.compactModel),
    compactReasoningEffort: text(value?.compactReasoningEffort),
    autoClassifierEnabled: value?.autoClassifierEnabled ?? false,
    autoInstantProvider: text(value?.autoInstantProvider),
    autoInstantModel: text(value?.autoInstantModel),
    autoInstantReasoningEffort: text(value?.autoInstantReasoningEffort),
    autoThinkingProvider: text(value?.autoThinkingProvider),
    autoThinkingModel: text(value?.autoThinkingModel),
    autoThinkingReasoningEffort: text(value?.autoThinkingReasoningEffort),
    autoProProvider: text(value?.autoProProvider),
    autoProModel: text(value?.autoProModel),
    autoProReasoningEffort: text(value?.autoProReasoningEffort),
    autoClassifierProvider: text(value?.autoClassifierProvider),
    autoClassifierModel: text(value?.autoClassifierModel),
    autoClassifierReasoningEffort: text(value?.autoClassifierReasoningEffort),
  }
}

export function isAutoModel(selection: Pick<AuxiliaryModelSettings, 'provider' | 'model'>): boolean {
  return selection.provider === AUTO_PROVIDER && selection.model === AUTO_MODEL
}

export function autoRouteMapOf(settings: EnhancerSettings): AutoRouteMap {
  return {
    instant: {
      provider: settings.autoInstantProvider,
      model: settings.autoInstantModel,
      reasoningEffort: settings.autoInstantReasoningEffort,
    },
    thinking: {
      provider: settings.autoThinkingProvider,
      model: settings.autoThinkingModel,
      reasoningEffort: settings.autoThinkingReasoningEffort,
    },
    pro: {
      provider: settings.autoProProvider,
      model: settings.autoProModel,
      reasoningEffort: settings.autoProReasoningEffort,
    },
    classifier: {
      provider: settings.autoClassifierProvider,
      model: settings.autoClassifierModel,
      reasoningEffort: settings.autoClassifierReasoningEffort,
    },
  }
}

export function auxiliaryModelOf(
  settings: EnhancerSettings,
  feature: AuxiliaryFeature,
): AuxiliaryModelSettings {
  switch (feature) {
    case 'optimize':
      return {
        provider: settings.optimizeProvider,
        model: settings.optimizeModel,
        reasoningEffort: settings.optimizeReasoningEffort,
      }
    case 'predict':
      return {
        provider: settings.predictProvider,
        model: settings.predictModel,
        reasoningEffort: settings.predictReasoningEffort,
      }
    case 'compact':
      return {
        provider: settings.compactProvider,
        model: settings.compactModel,
        reasoningEffort: settings.compactReasoningEffort,
      }
    default: {
      const _exhaustive: never = feature
      return _exhaustive
    }
  }
}

export function isFollowSessionModel(selection: AuxiliaryModelSettings): boolean {
  return selection.provider === '' || selection.model === ''
}
