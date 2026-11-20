/**
 * "The site changed": a saved flow stopped at a control that moved, and the
 * agent finished the job by hand. What the agent actually did is the evidence a
 * repair needs, so this module turns that evidence into a small, reviewable
 * diff instead of letting the flow silently rewrite itself.
 *
 * Safety rules, in one place:
 * - a masked secret is never a drift (it is a pause for the user, not a change);
 * - only the *locator* is repaired, never the recorded action's value, and never
 *   the number of steps beyond what the agent visibly had to add;
 * - anything that looks like a secret on the observing side is dropped, because
 *   a repaired flow must still be safe to store.
 */

import { describeDemoStep, sanitizeDemoSteps, type DemoStep } from './demo.ts'
import { normalizeControlName } from './demo-replay.ts'

/** One action the agent took after a replay stopped. Built by the tool layer. */
export interface DemoObservedAction {
  readonly kind: 'click' | 'fill' | 'press' | 'navigate'
  readonly at: number
  readonly role?: string
  readonly name?: string
  readonly selector?: string
  readonly field?: string
  readonly value?: string
  readonly key?: string
  readonly url?: string
  readonly tabId?: number
  readonly tabUrl?: string
}

/** A flow that stopped, waiting to see what the agent does next. */
export interface DemoRepairTarget {
  readonly recipeId: string
  readonly recipeName: string
  /** 0-based index of the step that stopped the replay. */
  readonly index: number
  readonly step: DemoStep
  readonly reason: string
  readonly at: number
  readonly tabId?: number
  readonly tabUrl?: string
}

/** A repair the user can accept; accepting is the only thing that writes. */
export interface DemoHealProposal {
  readonly id: string
  readonly at: number
  /** 1-based step number that stopped the replay (as the user sees it). */
  readonly failedAt: number
  readonly reason: string
  /** Steps the agent added before it reached the right control (a banner…). */
  readonly inserted: readonly DemoStep[]
  /** What the flow will use from now on; keeps the recorded value. */
  readonly replacement: DemoStep
}

/** Observation window and caps: a repair is a minute of work, not a session. */
const REPAIR_WINDOW_MS = 10 * 60_000
const MAX_OBSERVED = 30
const MAX_INSERTED = 8

/**
 * A click on a field to type into it is not a step of its own, and an empty
 * value means "focused", not "filled".
 */
function stepFromObservation(action: DemoObservedAction): DemoStep | null {
  switch (action.kind) {
    case 'navigate':
      return action.url === undefined || action.url === ''
        ? null
        : { kind: 'navigate', at: action.at, url: action.url }
    case 'click':
      return action.name === undefined || action.name === ''
        ? null
        : {
          kind: 'click',
          at: action.at,
          role: action.role ?? 'button',
          name: action.name,
          selector: action.selector ?? '',
        }
    case 'fill':
      return action.name === undefined || action.name === '' || (action.value ?? '') === ''
        ? null
        : {
          kind: 'fill',
          at: action.at,
          role: action.role ?? 'textbox',
          name: action.name,
          selector: action.selector ?? '',
          field: action.field ?? action.name,
          value: action.value ?? '',
          masked: false,
        }
    case 'press':
      return action.key === undefined || action.key === ''
        ? null
        : { kind: 'press', at: action.at, key: action.key, selector: action.selector ?? '' }
    default: {
      const exhaustive: never = action.kind
      return exhaustive
    }
  }
}

/**
 * The failed step with the agent's locator, keeping the recorded value: the
 * point of a repair is that the control moved, not that this run's value
 * became the new default.
 */
function retarget(step: DemoStep, action: DemoObservedAction): DemoStep | null {
  if (step.kind !== action.kind) return null
  const site = {
    ...(step.tabId === undefined ? {} : { tabId: step.tabId }),
    ...(step.tabUrl === undefined ? {} : { tabUrl: step.tabUrl }),
  }
  switch (step.kind) {
    case 'navigate':
      return { ...step, url: action.url ?? step.url }
    case 'click':
      // The old href belonged to the old control; carrying it over would let the
      // dead-click fallback reopen a URL the page no longer links to.
      return {
        kind: 'click',
        at: step.at,
        role: action.role ?? step.role,
        name: action.name ?? step.name,
        selector: action.selector ?? step.selector,
        ...site,
      }
    case 'fill':
      return {
        kind: 'fill',
        at: step.at,
        role: action.role ?? step.role,
        name: action.name ?? step.name,
        selector: action.selector ?? step.selector,
        field: action.field ?? step.field,
        value: step.value,
        masked: step.masked,
        ...(step.checked === undefined ? {} : { checked: step.checked }),
        ...site,
      }
    case 'press':
      return {
        kind: 'press',
        at: step.at,
        key: step.key,
        selector: action.selector ?? step.selector,
        ...site,
      }
    default: {
      const exhaustive: never = step
      return exhaustive
    }
  }
}

/**
 * Which observation stands in for the failed step: the one whose label still
 * looks like the recorded one, otherwise the first of the same kind (a full
 * rename leaves nothing to compare). Everything before it was added work.
 */
function pickObserved(step: DemoStep, observed: readonly DemoObservedAction[]): number {
  const compatible: Array<{ readonly action: DemoObservedAction; readonly index: number }> = []
  observed.forEach((action, index) => {
    if (action.kind !== step.kind) return
    if (step.kind !== 'navigate' && (action.name ?? '') === '') return
    if (step.kind === 'fill' && (action.value ?? '') === '') return
    compatible.push({ action, index })
  })
  if (compatible.length === 0) return -1
  if (step.kind === 'navigate') return compatible[0]!.index

  const wanted = step.kind === 'press' ? '' : normalizeControlName(step.name)
  if (wanted !== '') {
    const similar = compatible.find(({ action }) => {
      const candidate = normalizeControlName(action.name ?? '')
      if (candidate === '') return false
      if (candidate.length < 2 || wanted.length < 2) return candidate === wanted
      return candidate.includes(wanted) || wanted.includes(candidate)
    })
    if (similar !== undefined) return similar.index
  }
  return compatible[0]!.index
}

/**
 * Build the diff for a stopped flow, or null when the observations do not
 * support one (different kind of control, a secret, no visible change).
 */
export function buildHealProposal(input: {
  readonly steps: readonly DemoStep[]
  /** 0-based index the replay stopped at. */
  readonly failedIndex: number
  readonly reason: string
  readonly observed: readonly DemoObservedAction[]
  readonly now: number
  readonly id?: string
}): DemoHealProposal | null {
  const step = input.steps[input.failedIndex]
  if (step === undefined) return null
  // A masked secret is a pause for the user, not a page change.
  if (step.kind === 'fill' && step.masked) return null

  const matchAt = pickObserved(step, input.observed)
  if (matchAt < 0) return null
  const action = input.observed[matchAt]!
  const replacement = retarget(step, action)
  if (replacement === null) return null

  // Nothing actually moved: keep the flow as recorded instead of churning it.
  const unchanged = step.kind === 'navigate'
    ? replacement.kind === 'navigate' && step.url === replacement.url
    : step.kind === 'press'
      ? replacement.kind === 'press' && step.selector === replacement.selector
      : 'name' in replacement && 'name' in step
        && normalizeControlName(step.name) === normalizeControlName(replacement.name)
        && step.role === replacement.role
  if (unchanged) return null

  const inserted: DemoStep[] = []
  for (const entry of input.observed.slice(0, matchAt)) {
    if (inserted.length >= MAX_INSERTED) break
    const built = stepFromObservation(entry)
    if (built !== null) inserted.push(built)
  }
  const sanitizedInserted = sanitizeDemoSteps(inserted)
  // A repaired flow that would still stop on a secret is not a repair.
  if (sanitizedInserted.some(entry => entry.kind === 'fill' && entry.masked)) return null
  const sanitizedReplacement = sanitizeDemoSteps([replacement])[0] ?? replacement
  if (sanitizedReplacement.kind === 'fill' && sanitizedReplacement.masked) return null

  return {
    id: input.id ?? `h-${input.now.toString(36)}`,
    at: input.now,
    failedAt: input.failedIndex + 1,
    reason: input.reason.slice(0, 500),
    inserted: sanitizedInserted,
    replacement: sanitizedReplacement,
  }
}

/**
 * Same control as when the replay stopped? Guards against accepting a repair
 * after the flow changed underneath it (a re-recording, a parameterisation).
 */
function sameIdentity(a: DemoStep, b: DemoStep): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'navigate' && b.kind === 'navigate') return a.url === b.url
  if (a.kind === 'press' && b.kind === 'press') return a.key === b.key
  if ('name' in a && 'name' in b) {
    return normalizeControlName(a.name) === normalizeControlName(b.name) && a.role === b.role
  }
  return false
}

/** Apply a proposal to a flow's steps (1-based failedAt → 0-based slice). */
export function applyHealProposal(
  steps: readonly DemoStep[],
  proposal: DemoHealProposal,
): DemoStep[] {
  const at = proposal.failedAt - 1
  if (at < 0 || at >= steps.length) return [...steps]
  return [
    ...steps.slice(0, at),
    ...proposal.inserted,
    proposal.replacement,
    ...steps.slice(at + 1),
  ]
}

/** Human line for tool output (the panel localises its own copy). */
export function describeHealProposal(proposal: DemoHealProposal): string[] {
  const lines = [
    `step ${proposal.failedAt} now uses ${describeDemoStep(proposal.replacement)}`,
  ]
  if (proposal.inserted.length > 0) {
    lines.push(`+${proposal.inserted.length} step(s) before it: ${proposal.inserted.map(describeDemoStep).join('; ')}`)
  }
  return lines
}

/** A repair the panel can offer; accepting is the only write. */
export interface RepairCommitResult {
  readonly recipeId: string
  readonly recipeName: string
  readonly failedAt: number
  readonly lines: readonly string[]
}

/** What the tool layer tells the host about a stopped flow and the work after it. */
export interface BrowserRepairHooks {
  /** Cheap guard so clicks outside a repair do not pay for evidence capture. */
  readonly active: () => boolean
  begin(input: {
    readonly recipeId: string
    readonly recipeName: string
    readonly index: number
    readonly step: DemoStep
    readonly reason: string
    readonly tabId?: number
    readonly tabUrl?: string
  }): void
  observe(action: DemoObservedAction): void
  /** Close the tracker and store a proposal. Null when there was nothing to learn. */
  commit(): RepairCommitResult | null
}

/**
 * Wire a tracker to a recipe store. Committing writes a proposal, never the
 * flow; `resolveHeal({ accept: true })` is the only path that rewrites steps.
 */
export function createRepairHooks(input: {
  readonly tracker: DemoRepairTracker
  readonly store?: {
    get(id: string): {
      readonly id: string
      readonly name: string
      readonly steps: readonly DemoStep[]
    } | undefined
    recordHeal(entry: { readonly id: string; readonly proposal: DemoHealProposal }): { readonly ok: boolean }
  }
  readonly now?: () => number
}): BrowserRepairHooks {
  const clock = input.now ?? Date.now
  return {
    active: () => input.tracker.active,
    begin: target => { input.tracker.begin(target) },
    observe: action => { input.tracker.observe(action) },
    commit: () => {
      const pending = input.tracker.take()
      if (pending === null || input.store === undefined) return null
      const recipe = input.store.get(pending.target.recipeId)
      if (recipe === undefined) return null
      // The flow may have been re-recorded or parameterised while the agent was
      // working; the index would then point at a different step.
      const current = recipe.steps[pending.target.index]
      if (current === undefined || !sameIdentity(current, pending.target.step)) return null
      const now = clock()
      const proposal = buildHealProposal({
        steps: recipe.steps,
        failedIndex: pending.target.index,
        reason: pending.target.reason,
        observed: pending.observed,
        now,
      })
      if (proposal === null) return null
      if (!input.store.recordHeal({ id: recipe.id, proposal }).ok) return null

      return {
        recipeId: recipe.id,
        recipeName: recipe.name,
        failedAt: proposal.failedAt,
        lines: describeHealProposal(proposal),
      }
    },
  }
}

/**
 * Watches what the agent does after a replay stops. The tracker is deliberately
 * dumb: it collects, and the caller decides whether a proposal is worth storing.
 */
export class DemoRepairTracker {
  private pending: {
    readonly target: DemoRepairTarget
    readonly observed: DemoObservedAction[]
  } | null = null

  begin(target: Omit<DemoRepairTarget, 'at'> & { readonly at?: number }): void {
    this.pending = {
      target: { ...target, at: target.at ?? Date.now() },
      observed: [],
    }
  }

  observe(action: DemoObservedAction): void {
    const pending = this.pending
    if (pending === null) return
    if (action.at - pending.target.at > REPAIR_WINDOW_MS) return
    if (pending.target.tabId !== undefined && action.tabId !== undefined
      && pending.target.tabId !== action.tabId) return
    if (pending.observed.length >= MAX_OBSERVED) return
    pending.observed.push(action)
  }

  /** Hand back the target and what happened, and stop tracking. */
  take(): { readonly target: DemoRepairTarget; readonly observed: readonly DemoObservedAction[] } | null {
    const pending = this.pending
    this.pending = null
    return pending === null ? null : { target: pending.target, observed: [...pending.observed] }
  }

  get active(): boolean {
    return this.pending !== null
  }
}
