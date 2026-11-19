/**
 * Replay a recorded demonstration without a model turn in between.
 *
 * The user just showed the flow; `browser_demonstrate({ replay: true })` runs it
 * once so the next message can report what happened instead of asking the model
 * to click everything again. Matching is by role + accessible name against a
 * fresh snapshot — recorded selectors are for humans and refs change per run.
 *
 * Anything that cannot be reproduced honestly (a secret the recorder masked, a
 * <select> whose options we cannot address by name, a control that is gone)
 * stops the replay at that step and hands back what is left. A half-replayed
 * flow that says where it stopped beats a guess.
 */

import { describeDemoStep, type DemoStep } from './demo.ts'

export interface DemoReplayNode {
  readonly ref: number
  readonly role: string
  readonly name: string
}

/** The slice of BrowserDriver the replay needs (kept small for tests). */
export interface DemoReplayDriver {
  snapshot(): Promise<{
    readonly url: string
    readonly nodes: readonly DemoReplayNode[]
  }>
  click(ref: number): Promise<{ readonly url: string }>
  type(ref: number, text: string): Promise<{ readonly url: string }>
  /** Keyboard press in the bound tab (used for recorded Enter presses). */
  press(key: string): Promise<{ readonly url: string }>
  navigate(url: string): Promise<{ readonly url: string }>
  followTab(tabId: number): Promise<{ readonly url: string }>
}

export interface DemoReplayDone {
  readonly status: 'done'
  readonly performed: number
  readonly total: number
  /** One line per performed step: `1. ok   click link "报表"`. */
  readonly lines: readonly string[]
  readonly url: string
}

export interface DemoReplayBlocked {
  readonly status: 'blocked'
  readonly performed: number
  readonly total: number
  readonly lines: readonly string[]
  /** Why the replay stopped, in terms of the step that could not run. */
  readonly reason: string
  /** Steps still to do, starting with the one that stopped the replay. */
  readonly pending: readonly DemoStep[]
  readonly url?: string
}

export type DemoReplayResult = DemoReplayDone | DemoReplayBlocked

/** Case/whitespace-insensitive accessible-name key. */
export function normalizeControlName(raw: string): string {
  return raw
    .replace(/[\u200b-\u200d\ufeff]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Find the control a recorded step refers to. Exact role+name first, then the
 * same name under another role, then a unique partial name — a demo recorded
 * against "导出" must still find "导出报表" if the label was shortened.
 */
export function matchDemoControl(
  nodes: readonly DemoReplayNode[],
  role: string,
  name: string,
): DemoReplayNode | undefined {
  const wanted = normalizeControlName(name)
  if (wanted === '') return undefined
  const sameRole = nodes.filter(node => node.role === role)
  const exact = sameRole.find(node => normalizeControlName(node.name) === wanted)
  if (exact !== undefined) return exact
  const exactAnyRole = nodes.find(node => normalizeControlName(node.name) === wanted)
  if (exactAnyRole !== undefined) return exactAnyRole
  const partial = sameRole.filter(node => {
    const candidate = normalizeControlName(node.name)
    return candidate.includes(wanted) || wanted.includes(candidate)
  })
  return partial.length === 1 ? partial[0] : undefined
}

type StepOutcome =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: string }

/** Why a recorded step cannot be replayed as recorded. */
function replayObstacle(step: DemoStep): string | null {
  if (step.kind !== 'fill') return null
  if (step.masked) return `secret field ${JSON.stringify(step.name)} was masked; type it yourself`
  if (step.role === 'combobox') return `select ${JSON.stringify(step.name)} cannot be replayed by name`
  if (step.role === 'checkbox' || step.role === 'radio') {
    return `${step.role} ${JSON.stringify(step.name)} cannot be replayed by name (click it, then continue)`
  }
  return null
}

async function performStep(driver: DemoReplayDriver, step: DemoStep): Promise<StepOutcome> {
  switch (step.kind) {
    case 'navigate': {
      const current = (await driver.snapshot()).url
      if (current === step.url) return { ok: true, url: current }
      const result = await driver.navigate(step.url)
      return { ok: true, url: result.url }
    }
    case 'click': {
      const snapshot = await driver.snapshot()
      const node = matchDemoControl(snapshot.nodes, step.role, step.name)
      if (node === undefined) {
        return { ok: false, reason: `no control matching ${step.role} ${JSON.stringify(step.name)} on this page` }
      }
      const result = await driver.click(node.ref)
      return { ok: true, url: result.url }
    }
    case 'fill': {
      const snapshot = await driver.snapshot()
      const node = matchDemoControl(snapshot.nodes, step.role, step.name)
      if (node === undefined) {
        return { ok: false, reason: `no field matching ${step.role} ${JSON.stringify(step.name)} on this page` }
      }
      const result = await driver.type(node.ref, step.value)
      return { ok: true, url: result.url }
    }
    case 'press': {
      const result = await driver.press(step.key)
      return { ok: true, url: result.url }
    }
    default: {
      const exhaustive: never = step
      return { ok: false, reason: `unsupported step ${JSON.stringify(exhaustive)}` }
    }
  }
}

/**
 * Run the recorded steps in order. Stops at the first step that cannot be
 * reproduced, so the caller can name it instead of claiming a full replay.
 */
export async function replayDemoSteps(
  driver: DemoReplayDriver,
  steps: readonly DemoStep[],
): Promise<DemoReplayResult> {
  const lines: string[] = []
  let currentTab: number | undefined
  let url: string | undefined

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!
    if (step.tabId !== undefined && step.tabId !== currentTab) {
      try {
        const followed = await driver.followTab(step.tabId)
        currentTab = step.tabId
        url = followed.url
      } catch {
        return {
          status: 'blocked',
          performed: index,
          total: steps.length,
          lines,
          reason: `tab ${step.tabId} is no longer open`,
          pending: steps.slice(index),
          ...(url === undefined ? {} : { url }),
        }
      }
    }
    const obstacle = replayObstacle(step)
    if (obstacle !== null) {
      return {
        status: 'blocked',
        performed: index,
        total: steps.length,
        lines,
        reason: obstacle,
        pending: steps.slice(index),
        ...(url === undefined ? {} : { url }),
      }
    }
    const outcome = await performStep(driver, step).catch((error: unknown) => ({
      ok: false as const,
      reason: error instanceof Error ? error.message : String(error),
    }))
    if (!outcome.ok) {
      return {
        status: 'blocked',
        performed: index,
        total: steps.length,
        lines,
        reason: outcome.reason,
        pending: steps.slice(index),
        ...(url === undefined ? {} : { url }),
      }
    }
    url = outcome.url
    lines.push(`${index + 1}. ok   ${describeDemoStep(step)}`)
  }

  return {
    status: 'done',
    performed: steps.length,
    total: steps.length,
    lines,
    url: url ?? '',
  }
}
