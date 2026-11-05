import type { Context } from '@deepseek-ai/cordis'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Pure helper: fold surface turns/steps onto a Host sessionStats-shaped object.
 * Kept for checkpoint UI / tests — do **not** apply this back onto Host
 * `sessionStats` (official ActivityPill and the experimental stats page own
 * whole-log counts; overwriting them creates a dual ledger after restore).
 */
export function withActivityCounts(
  base: unknown,
  activity: { readonly turns: number, readonly steps: number },
): unknown {
  if (!isRecord(base)) return base
  if (base.turns === activity.turns && base.steps === activity.steps) return base
  return { ...base, turns: activity.turns, steps: activity.steps }
}

/**
 * Formerly rewrote Host `sessionStats` turns/steps to the presented chat
 * surface. That fought Desktop 0.2.2 session statistics and the experimental
 * stats plugin (whole-log ledger). Surface counts now live only on the
 * checkpoint timeline lead / restore tip copy.
 */
export function installRollbackSessionStatsFilter(_ctx: Context): () => void {
  return () => {}
}
