import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'

export interface SessionModelPick {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

type ModelSelectionState = {
  pending?: SessionModelPick | null
  lastUsed?: SessionModelPick | null
}

/** Same priority as the main Auto session hook: pending selection, then last used, then host default. */
export function projectedSessionModel(ctx: Context, session: Session): SessionModelPick {
  try {
    const projections = ctx.get('sessionProjections') as
      | { stateOf?: (session: Session, key: string) => unknown }
      | undefined
    // 0.2.2: legacy key stateOf remains runtime-compatible but returns unknown.
    const state = projections?.stateOf?.(session, 'modelSelection') as ModelSelectionState | undefined
    if (state?.pending !== undefined && state.pending !== null) return state.pending
    if (state?.lastUsed !== undefined && state.lastUsed !== null) return state.lastUsed
  } catch {
    // Inactive context / missing inject — fall through to default model.
  }
  try {
    const defaults = ctx.get('agentDefaultModel') as { currentSelection?: () => SessionModelPick } | undefined
    const selection = defaults?.currentSelection?.()
    if (selection !== undefined) return selection
  } catch {
    // ignore
  }
  return { provider: '', model: '' }
}
