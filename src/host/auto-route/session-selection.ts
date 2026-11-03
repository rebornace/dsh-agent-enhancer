import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'

export interface SessionModelPick {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Same priority as the main Auto session hook: pending selection, then last used, then host default. */
export function projectedSessionModel(ctx: Context, session: Session): SessionModelPick {
  try {
    const projections = ctx.get('sessionProjections') as
      | { stateOf?: (session: Session, key: string) => { pending?: SessionModelPick | null, lastUsed?: SessionModelPick | null } | undefined }
      | undefined
    const state = projections?.stateOf?.(session, 'modelSelection')
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
