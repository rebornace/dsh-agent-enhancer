import type { RunAlertsLevel } from '../../config.ts'
import type { DeliverChannel } from './types.ts'

export interface AlertGateInput {
  readonly level: RunAlertsLevel
  readonly documentHidden: boolean
  /** `document.hasFocus()` — false on dual-monitor / other-app attention. */
  readonly windowFocused: boolean
  /** True when the session is retained as the main conversation view. */
  readonly isMainView: boolean
}

/**
 * Decide whether to notify for one event under the user's chosen level.
 * - hidden: only when the page is not visible (minimized / covered tab)
 * - unfocused: page hidden, window blurred, or another session is focused (default)
 * - always: even while watching that session
 */
export function shouldDeliverAlert(input: AlertGateInput): boolean {
  switch (input.level) {
    case 'always':
      return true
    case 'unfocused':
      if (input.documentHidden || !input.windowFocused) return true
      return !input.isMainView
    case 'hidden':
      return input.documentHidden
    default: {
      const _exhaustive: never = input.level
      return _exhaustive
    }
  }
}

/** Prefer OS notification whenever the user is not looking at this window. */
export function deliverChannel(input: {
  readonly documentHidden: boolean
  readonly windowFocused: boolean
}): DeliverChannel {
  if (input.documentHidden || !input.windowFocused) return 'notification'
  return 'toast'
}

/** True when the user is away from the Desktop page for finish-edge heuristics. */
export function isAway(documentHidden: boolean, windowFocused: boolean): boolean {
  return documentHidden || !windowFocused
}
