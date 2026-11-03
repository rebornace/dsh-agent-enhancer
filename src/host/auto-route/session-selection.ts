import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'

export interface SessionModelPick {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Same priority as the main Auto session hook: pending selection, then last used, then host default. */
export function projectedSessionModel(ctx: Context, session: Session): SessionModelPick {
  const state = ctx.sessionProjections.stateOf(session, 'modelSelection')
  return state?.pending ?? state?.lastUsed ?? ctx.agentDefaultModel.currentSelection()
}
