/**
 * One place that turns browser-agent state into "what is wrong and what to do".
 *
 * The old status was `ready: false` plus whatever Playwright last threw, which
 * left both the model and the user guessing. Every failure we actually see has a
 * known next step: a missing engine binary, no browser on the machine, or a
 * profile still held by a leftover window.
 */

export type BrowserDiagnosisCode =
  | 'disabled'
  | 'idle'
  | 'ok'
  | 'webkit_missing'
  | 'browser_missing'
  | 'profile_locked'
  | 'launch_failed'

export interface BrowserAvailability {
  readonly chrome: boolean
  readonly edge: boolean
  readonly safari: boolean
}

export interface DiagnosisInput {
  readonly enabled: boolean
  readonly ready: boolean
  readonly preference: 'auto' | 'chrome' | 'edge' | 'safari'
  readonly platform: string
  readonly lastError?: string | null
  readonly availability: BrowserAvailability
}

export interface Diagnosis {
  readonly code: BrowserDiagnosisCode
  /** Model-facing, English, one or two sentences with the concrete next step. */
  readonly nextStep: string
  readonly detail?: string
  /** Which browsers this machine actually has, so the UI can show it plainly. */
  readonly browsers: BrowserAvailability
}

const PROFILE_LOCK = /ProcessSingleton|SingletonLock|already in use|profile.*(?:lock|use)|EBUSY|EACCES|EPERM/i

const AVAILABILITY: Record<keyof BrowserAvailability, keyof BrowserAvailability> = { chrome: 'chrome', edge: 'edge', safari: 'safari' }

/** Browsers that can actually satisfy the current preference on this platform. */
export function usableBrowsers(input: {
  readonly preference: 'auto' | 'chrome' | 'edge' | 'safari'
  readonly platform: string
  readonly availability: BrowserAvailability
}): readonly string[] {
  const { availability, platform } = input
  const order: readonly (keyof BrowserAvailability)[] = input.preference === 'auto'
    ? (platform === 'win32'
      ? ['edge', 'chrome']
      : platform === 'darwin'
        ? ['safari', 'chrome']
        : ['chrome'])
    : [AVAILABILITY[input.preference]]
  return order.filter(name => availability[name] === true)
}

export function diagnose(input: DiagnosisInput): Diagnosis {
  return { ...classify(input), browsers: input.availability }
}

function classify(input: DiagnosisInput): Omit<Diagnosis, 'browsers'> {
  const detail = typeof input.lastError === 'string' && input.lastError.trim() !== ''
    ? input.lastError.trim()
    : undefined

  if (!input.enabled) {
    return {
      code: 'disabled',
      nextStep: 'Browser agent is off. Ask the user to enable 设置 → 智能体增强 → 功能 → 浏览器 Agent, then retry.',
    }
  }

  if (input.ready) {
    return {
      code: 'ok',
      nextStep: 'Ready: page tools act on the bound tab listed above.',
    }
  }

  const usable = usableBrowsers(input)

  if (detail !== undefined && /WEBKIT_MISSING/i.test(detail)) {
    return {
      code: 'webkit_missing',
      detail,
      nextStep: 'The WebKit engine for the Safari option is not installed. Either run `npx playwright install webkit` '
        + 'and retry, or switch the browser setting to Chrome/Edge, which needs no extra download.',
    }
  }

  if (input.preference === 'safari' && !input.availability.safari) {
    return {
      code: 'browser_missing',
      detail,
      nextStep: 'Safari is not present on this machine, and the Safari option drives the WebKit engine. '
        + 'Switch the browser setting to Chrome, or on macOS install Safari first.',
    }
  }

  if (usable.length === 0 && detail === undefined) {
    return {
      code: 'browser_missing',
      nextStep: `No usable browser found for preference "${input.preference}" on ${input.platform}. `
        + 'Install Chrome (or Edge on Windows) or change the browser setting, then retry.',
    }
  }

  if (detail !== undefined && PROFILE_LOCK.test(detail)) {
    return {
      code: 'profile_locked',
      detail,
      nextStep: 'The dedicated profile is still held by another process — usually a leftover agent browser window '
        + 'or a second Desktop instance. Close it (or quit the other instance), then retry; no settings change needed.',
    }
  }

  if (detail !== undefined) {
    return {
      code: 'launch_failed',
      detail,
      nextStep: 'Launch failed. Check the browser choice in Settings → 智能体增强 → 功能 → 浏览器 Agent, '
        + 'and retry once. If it keeps failing, the detail above names the missing piece.',
    }
  }

  return {
    code: 'idle',
    nextStep: 'Nothing launched yet. Call browser_navigate (or Alt+click a chat link) to launch the dedicated browser; '
      + 'do not ask the user to start it manually.',
  }
}
